/**
 * API Routes
 * 
 * REST API endpoints for the frontend to consume.
 */

import { Router } from 'express';
import { supabase } from '../lib/supabase';
import { keyPool } from '../lib/key-pool';

export const apiRouter = Router();

/**
 * GET /api/topics
 * Get hot topics, optionally filtered by category and status.
 * 
 * Query params:
 * - category: string (default: 'AI')
 * - status: 'emerging' | 'warming' | 'hot' | 'peak' | 'declining' (optional)
 * - hours: number (how far back to look, default: 24)
 * - limit: number (default: 20)
 */
apiRouter.get('/topics', async (req, res) => {
    try {
        const category = (req.query.category as string) || 'AI';
        const status = req.query.status as string;
        const hours = parseInt((req.query.hours as string) || '24', 10);
        const limit = parseInt((req.query.limit as string) || '20', 10);

        const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        let query = supabase
            .from('hot_topics')
            .select('*')
            .eq('category', category)
            .gte('detected_at', since)
            .order('confidence_score', { ascending: false })
            .limit(limit);

        if (status) {
            query = query.eq('status', status);
        }

        const { data, error } = await query;

        if (error) throw error;

        res.json({ topics: data, count: data?.length || 0 });
    } catch (error) {
        console.error('[API] Error fetching topics:', error);
        res.status(500).json({ error: 'Failed to fetch topics' });
    }
});

/**
 * GET /api/topics/latest
 * Get the single most recent analysis result per category.
 * This is what the frontend dashboard shows as "current hot topics".
 */
apiRouter.get('/topics/latest', async (req, res) => {
    try {
        const category = (req.query.category as string) || 'AI';

        // Get the latest detected_at timestamp
        const { data: latest } = await supabase
            .from('hot_topics')
            .select('detected_at')
            .eq('category', category)
            .order('detected_at', { ascending: false })
            .limit(1);

        if (!latest || latest.length === 0) {
            return res.json({ topics: [], analyzedAt: null });
        }

        const latestTimestamp = latest[0].detected_at;

        // Get all topics from that analysis cycle (within 2 min window)
        const windowStart = new Date(new Date(latestTimestamp).getTime() - 120000).toISOString();

        const { data: topics, error } = await supabase
            .from('hot_topics')
            .select('*')
            .eq('category', category)
            .gte('detected_at', windowStart)
            .lte('detected_at', latestTimestamp)
            .order('confidence_score', { ascending: false });

        if (error) throw error;

        res.json({
            topics: topics || [],
            analyzedAt: latestTimestamp,
            count: topics?.length || 0,
        });
    } catch (error) {
        console.error('[API] Error fetching latest topics:', error);
        res.status(500).json({ error: 'Failed to fetch latest topics' });
    }
});

/**
 * GET /api/topics/:id
 * Get details of a specific topic, including associated tweets.
 */
apiRouter.get('/topics/:id', async (req, res) => {
    try {
        const { id } = req.params;

        const { data: topic, error } = await supabase
            .from('hot_topics')
            .select('*')
            .eq('id', id)
            .single();

        if (error) throw error;
        if (!topic) return res.status(404).json({ error: 'Topic not found' });

        // Fetch associated tweets if we have example tweet IDs
        let tweets: any[] = [];
        if (topic.example_tweet_ids && topic.example_tweet_ids.length > 0) {
            const { data: tweetData } = await supabase
                .from('tweets')
                .select(`
          *,
          engagement_snapshots (
            likes, retweets, replies, views, bookmarks,
            engagement_rate, performance_multiplier,
            snapshot_at
          )
        `)
                .in('tweet_id', topic.example_tweet_ids);

            tweets = tweetData || [];
        }

        res.json({ topic, tweets });
    } catch (error) {
        console.error('[API] Error fetching topic:', error);
        res.status(500).json({ error: 'Failed to fetch topic' });
    }
});

/**
 * GET /api/influencers
 * Get list of tracked influencers.
 */
apiRouter.get('/influencers', async (req, res) => {
    try {
        const category = (req.query.category as string) || 'AI';

        const { data, error } = await supabase
            .from('influencers')
            .select('*')
            .eq('category', category)
            .order('follower_count', { ascending: false });

        if (error) throw error;

        res.json({ influencers: data, count: data?.length || 0 });
    } catch (error) {
        console.error('[API] Error fetching influencers:', error);
        res.status(500).json({ error: 'Failed to fetch influencers' });
    }
});

/**
 * GET /api/tweets/recent
 * Get recent tweets with engagement data.
 */
apiRouter.get('/tweets/recent', async (req, res) => {
    try {
        const category = (req.query.category as string) || 'AI';
        const hours = parseInt((req.query.hours as string) || '6', 10);
        const limit = parseInt((req.query.limit as string) || '50', 10);

        const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

        const { data, error } = await supabase
            .from('tweets')
            .select(`
        *,
        engagement_snapshots (
          likes, retweets, replies, views, bookmarks,
          engagement_rate, performance_multiplier,
          normalized_score, snapshot_at
        )
      `)
            .gte('posted_at', since)
            .eq('is_retweet', false)
            .order('posted_at', { ascending: false })
            .limit(limit);

        if (error) throw error;

        res.json({ tweets: data, count: data?.length || 0 });
    } catch (error) {
        console.error('[API] Error fetching tweets:', error);
        res.status(500).json({ error: 'Failed to fetch tweets' });
    }
});

/**
 * GET /api/stats
 * Get dashboard statistics.
 */
apiRouter.get('/stats', async (req, res) => {
    try {
        const category = (req.query.category as string) || 'AI';

        // Count influencers
        const { count: influencerCount } = await supabase
            .from('influencers')
            .select('*', { count: 'exact', head: true })
            .eq('category', category);

        // Count tweets in last 24h
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count: tweetCount24h } = await supabase
            .from('tweets')
            .select('*', { count: 'exact', head: true })
            .gte('posted_at', since24h);

        // Count hot topics in last 24h
        const { count: topicCount24h } = await supabase
            .from('hot_topics')
            .select('*', { count: 'exact', head: true })
            .gte('detected_at', since24h)
            .eq('category', category);

        // Total snapshots
        const { count: snapshotCount } = await supabase
            .from('engagement_snapshots')
            .select('*', { count: 'exact', head: true });

        res.json({
            influencersTracked: influencerCount || 0,
            tweetsLast24h: tweetCount24h || 0,
            topicsDetected24h: topicCount24h || 0,
            totalSnapshots: snapshotCount || 0,
            category,
        });
    } catch (error) {
        console.error('[API] Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

/**
 * GET /api/topics/history
 * Get topic detection history for trend visualization.
 */
apiRouter.get('/topics/history', async (req, res) => {
    try {
        const category = (req.query.category as string) || 'AI';
        const days = parseInt((req.query.days as string) || '7', 10);

        const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

        const { data, error } = await supabase
            .from('hot_topics')
            .select('topic_name, confidence_score, status, detected_at, influencer_count')
            .eq('category', category)
            .gte('detected_at', since)
            .order('detected_at', { ascending: false });

        if (error) throw error;

        res.json({ history: data, count: data?.length || 0 });
    } catch (error) {
        console.error('[API] Error fetching topic history:', error);
        res.status(500).json({ error: 'Failed to fetch history' });
    }
});

/**
 * GET /api/keys/status
 * Monitor API key pool health — see which keys are active, cooling down, or unhealthy.
 */
apiRouter.get('/keys/status', (req, res) => {
    try {
        const stats = keyPool.getStats();
        res.json(stats);
    } catch (error) {
        console.error('[API] Error fetching key status:', error);
        res.status(500).json({ error: 'Failed to fetch key pool status' });
    }
});

/**
 * POST /api/keys/reset
 * Force-reset all API key cooldowns. Use if keys recover from rate limits.
 */
apiRouter.post('/keys/reset', (req, res) => {
    try {
        keyPool.resetAll();
        const stats = keyPool.getStats();
        res.json({ message: 'All keys reset successfully', stats });
    } catch (error) {
        console.error('[API] Error resetting keys:', error);
        res.status(500).json({ error: 'Failed to reset keys' });
    }
});
