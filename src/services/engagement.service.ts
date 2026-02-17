/**
 * Engagement Service - Data Persistence Layer
 * 
 * Handles all Supabase operations: storing tweets, taking engagement snapshots,
 * managing influencers, and saving analysis results.
 */

import { supabase } from '../lib/supabase';
import {
    calculateEngagementRate,
    calculatePerformanceMultiplier,
    calculateVelocityScore,
    calculateNormalizedScore,
    type EngagementMetrics,
} from '../lib/scoring';
import type { FetchedTweet, FetchedUser } from './rettiwt.service';

/**
 * Upsert influencers from a list member fetch.
 * Updates follower counts and other profile data on each sync.
 */
export async function upsertInfluencers(users: FetchedUser[], category: string) {
    const records = users.map(user => ({
        twitter_id: user.twitterId,
        username: user.username,
        display_name: user.displayName,
        follower_count: user.followerCount,
        category,
        is_verified: user.isVerified,
        description: user.description,
        profile_image: user.profileImage,
        statuses_count: user.statusesCount,
        last_scraped_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('influencers')
        .upsert(records, { onConflict: 'twitter_id' });

    if (error) {
        console.error('[DB] Error upserting influencers:', error);
        throw error;
    }

    console.log(`[DB] Upserted ${records.length} influencers for category: ${category}`);
}

/**
 * Store scraped tweets. Checks for existing tweets first to avoid
 * re-processing. Only creates initial snapshots for TRULY NEW tweets.
 * 
 * Returns { newCount, existingCount } for logging.
 */
export async function storeTweets(tweets: FetchedTweet[]) {
    if (tweets.length === 0) return { newCount: 0, existingCount: 0 };

    // Filter out pure retweets — they don't tell us about trends
    const originalTweets = tweets.filter(t => !t.isRetweet);
    if (originalTweets.length === 0) return { newCount: 0, existingCount: 0 };

    // ── Step 1: Check which tweets already exist in the DB ──
    const tweetIds = originalTweets.map(t => t.tweetId);
    const { data: existingTweets } = await supabase
        .from('tweets')
        .select('tweet_id')
        .in('tweet_id', tweetIds);

    const existingTweetIds = new Set(
        existingTweets?.map(t => t.tweet_id) || []
    );

    // Split into new vs already-stored
    const newTweets = originalTweets.filter(t => !existingTweetIds.has(t.tweetId));
    const existingCount = originalTweets.length - newTweets.length;

    if (newTweets.length === 0) {
        console.log(`[DB] No new tweets to store (${existingCount} already in DB)`);
        return { newCount: 0, existingCount };
    }

    // ── Step 2: Get influencer DB IDs ──
    const twitterIds = [...new Set(newTweets.map(t => t.authorId))];
    const { data: influencers } = await supabase
        .from('influencers')
        .select('id, twitter_id, avg_engagement_rate')
        .in('twitter_id', twitterIds);

    const influencerMap = new Map(
        influencers?.map(i => [i.twitter_id, i]) || []
    );

    // ── Step 3: Insert ONLY new tweets ──
    const tweetRecords = newTweets.map(t => ({
        tweet_id: t.tweetId,
        influencer_id: influencerMap.get(t.authorId)?.id || null,
        content: t.content,
        posted_at: t.postedAt,
        author_username: t.authorUsername,
        author_followers: t.authorFollowers,
        hashtags: t.hashtags,
        keywords: [],
        is_retweet: t.isRetweet,
        is_reply: t.isReply,
        is_quote: t.isQuote,
        url: t.url,
        lang: t.lang,
    }));

    const { data: insertedTweets, error: tweetError } = await supabase
        .from('tweets')
        .insert(tweetRecords)
        .select('id, tweet_id');

    if (tweetError) {
        console.error('[DB] Error inserting tweets:', tweetError);
        throw tweetError;
    }

    // ── Step 4: Create initial snapshots ONLY for new tweets ──
    const tweetIdMap = new Map(
        insertedTweets?.map(t => [t.tweet_id, t.id]) || []
    );

    const snapshots = newTweets
        .filter(t => tweetIdMap.has(t.tweetId))
        .map(t => {
            const minutesSincePost = Math.max(1,
                (Date.now() - new Date(t.postedAt).getTime()) / 60000
            );
            const influencer = influencerMap.get(t.authorId);
            const metrics: EngagementMetrics = {
                likes: t.likes,
                retweets: t.retweets,
                replies: t.replies,
                quotes: t.quotes,
                views: t.views,
                bookmarks: t.bookmarks,
            };
            const engagementRate = calculateEngagementRate(metrics, t.authorFollowers);
            const performanceMultiplier = calculatePerformanceMultiplier(
                engagementRate,
                t.authorFollowers,
                influencer?.avg_engagement_rate || undefined
            );

            return {
                tweet_id: tweetIdMap.get(t.tweetId),
                likes: t.likes,
                retweets: t.retweets,
                replies: t.replies,
                quotes: t.quotes,
                views: t.views,
                bookmarks: t.bookmarks,
                engagement_rate: Math.round(engagementRate * 100) / 100,
                performance_multiplier: Math.round(performanceMultiplier * 100) / 100,
                velocity_score: Math.round(
                    calculateVelocityScore(metrics, minutesSincePost, t.authorFollowers) * 100
                ) / 100,
                normalized_score: calculateNormalizedScore(
                    performanceMultiplier,
                    calculateVelocityScore(metrics, minutesSincePost, t.authorFollowers),
                    minutesSincePost
                ),
                minutes_after_post: Math.round(minutesSincePost),
                snapshot_at: new Date().toISOString(),
            };
        });

    if (snapshots.length > 0) {
        const { error: snapshotError } = await supabase
            .from('engagement_snapshots')
            .insert(snapshots);

        if (snapshotError) {
            console.error('[DB] Error inserting initial snapshots:', snapshotError);
        }
    }

    console.log(
        `[DB] ✅ Stored ${newTweets.length} NEW tweets with ${snapshots.length} initial snapshots ` +
        `(skipped ${existingCount} already in DB)`
    );
    return { newCount: newTweets.length, existingCount };
}

/**
 * Take follow-up engagement snapshots for recent tweets.
 * Called on a separate interval to track engagement growth over time.
 */
export async function takeEngagementSnapshots(tweets: FetchedTweet[]) {
    if (tweets.length === 0) return;

    // Get existing tweets from DB
    const tweetIds = tweets.map(t => t.tweetId);
    const { data: existingTweets } = await supabase
        .from('tweets')
        .select('id, tweet_id, author_followers')
        .in('tweet_id', tweetIds);

    if (!existingTweets || existingTweets.length === 0) return;

    const tweetDbMap = new Map(
        existingTweets.map(t => [t.tweet_id, t])
    );

    // Get influencer avg rates for better scoring
    const { data: influencers } = await supabase
        .from('influencers')
        .select('twitter_id, avg_engagement_rate');
    const influencerRateMap = new Map(
        influencers?.map(i => [i.twitter_id, i.avg_engagement_rate]) || []
    );

    const snapshots = tweets
        .filter(t => tweetDbMap.has(t.tweetId))
        .map(t => {
            const dbTweet = tweetDbMap.get(t.tweetId)!;
            const minutesSincePost = Math.max(1,
                (Date.now() - new Date(t.postedAt).getTime()) / 60000
            );
            const metrics: EngagementMetrics = {
                likes: t.likes,
                retweets: t.retweets,
                replies: t.replies,
                quotes: t.quotes,
                views: t.views,
                bookmarks: t.bookmarks,
            };
            const followers = t.authorFollowers || dbTweet.author_followers || 1;
            const engagementRate = calculateEngagementRate(metrics, followers);
            const avgRate = influencerRateMap.get(t.authorId);
            const performanceMultiplier = calculatePerformanceMultiplier(
                engagementRate, followers, avgRate || undefined
            );
            const velocityScore = calculateVelocityScore(metrics, minutesSincePost, followers);

            return {
                tweet_id: dbTweet.id,
                likes: t.likes,
                retweets: t.retweets,
                replies: t.replies,
                quotes: t.quotes,
                views: t.views,
                bookmarks: t.bookmarks,
                engagement_rate: Math.round(engagementRate * 100) / 100,
                performance_multiplier: Math.round(performanceMultiplier * 100) / 100,
                velocity_score: Math.round(velocityScore * 100) / 100,
                normalized_score: calculateNormalizedScore(performanceMultiplier, velocityScore, minutesSincePost),
                minutes_after_post: Math.round(minutesSincePost),
                snapshot_at: new Date().toISOString(),
            };
        });

    if (snapshots.length > 0) {
        const { error } = await supabase
            .from('engagement_snapshots')
            .insert(snapshots);

        if (error) {
            console.error('[DB] Error inserting follow-up snapshots:', error);
        } else {
            console.log(`[DB] Took ${snapshots.length} follow-up engagement snapshots`);
        }
    }
}

/**
 * Get recent tweets with their latest engagement data for AI analysis.
 * Fetches tweets from the last N hours with their best engagement snapshot.
 */
export async function getRecentTweetsForAnalysis(category: string, hoursBack: number = 24) { // Increased to 24h to capture full viral lifecycle
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from('tweets')
        .select(`
      id,
      tweet_id,
      content,
      posted_at,
      author_username,
      author_followers,
      hashtags,
      is_retweet,
      is_reply,
      is_quote,
      url,
      influencers!inner (
        category
      ),
      engagement_snapshots (
        likes,
        retweets,
        replies,
        quotes,
        views,
        bookmarks,
        engagement_rate,
        performance_multiplier,
        velocity_score,
        normalized_score,
        snapshot_at
      )
    `)
        .eq('influencers.category', category)
        .gte('posted_at', since)
        .eq('is_retweet', false)
        .order('posted_at', { ascending: false });

    if (error) {
        console.error('[DB] Error fetching tweets for analysis:', error);
        return [];
    }

    // For each tweet, use the latest snapshot for engagement data
    return (data || []).map(tweet => {
        // Sort safely by date string comparison which is reliable for ISO strings
        const latestSnapshot = tweet.engagement_snapshots
            ?.sort((a: any, b: any) => new Date(b.snapshot_at).getTime() - new Date(a.snapshot_at).getTime())[0];

        return {
            tweetId: tweet.tweet_id,
            content: tweet.content,
            authorUsername: tweet.author_username,
            authorFollowers: tweet.author_followers,
            likes: latestSnapshot?.likes || 0,
            retweets: latestSnapshot?.retweets || 0,
            replies: latestSnapshot?.replies || 0,
            views: latestSnapshot?.views || 0,
            bookmarks: latestSnapshot?.bookmarks || 0,
            performanceMultiplier: latestSnapshot?.performance_multiplier || 1,
            engagementRate: latestSnapshot?.engagement_rate || 0,
            postedAt: tweet.posted_at,
            hashtags: tweet.hashtags || [],
            isRetweet: tweet.is_retweet,
        };
    });
}

/**
 * Get tweets that need their engagement metrics refreshed.
 * Strategy: Fetch tweets from last 24h.
 * Prioritize:
 * 1. Tweets that already have > 10 likes (showing promise)
 * 2. Tweets posted in the last 6 hours (give them a chance to pop)
 */
export async function getTweetsNeedingRefresh(hoursBack: number = 24) {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();

    const { data, error } = await supabase
        .from('tweets')
        .select(`
            id,
            tweet_id,
            posted_at,
            engagement_snapshots (
                likes,
                snapshot_at
            )
        `)
        .gte('posted_at', since)
        .order('posted_at', { ascending: false });

    if (error) {
        console.error('[DB] Error fetching refreshing candidates:', error);
        return [];
    }

    // Filter in-memory for simpler logic
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;

    return (data || []).map(tweet => {
        const latestSnapshot = tweet.engagement_snapshots
            ?.sort((a: any, b: any) => new Date(b.snapshot_at).getTime() - new Date(a.snapshot_at).getTime())[0];

        const likes = latestSnapshot?.likes || 0;
        const postedAtInfo = new Date(tweet.posted_at).getTime();

        // Keep if: High engagement OR Very new (< 2 hours)
        const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
        const needsRefresh = (likes > 100) || (postedAtInfo > twoHoursAgo);

        return needsRefresh ? { id: tweet.tweet_id, likes } : null;
    }).filter(item => item !== null)
        // Sort by likes descending, take top 20 only
        .sort((a: any, b: any) => b.likes - a.likes)
        .slice(0, 20)
        .map((item: any) => item.id) as string[];
}

/**
 * Save detected hot topics to the database.
 */
export async function saveHotTopics(topics: any[], category: string) {
    if (topics.length === 0) return;

    const records = topics.map(topic => ({
        topic_name: topic.name,
        topic_summary: topic.summary,
        keywords: topic.keywords || [],
        category,
        influencer_count: topic.influencerCount || 0,
        total_engagement: topic.totalEngagement || 0,
        avg_performance_multiplier: topic.avgPerformanceMultiplier || 1,
        confidence_score: topic.score || 0,
        status: topic.status || 'emerging',
        suggested_angles: topic.suggestedAngles || [],
        content_ideas: topic.contentIdeas || [],
        why_it_matters: topic.whyItMatters || '',
        time_to_act: topic.timeToAct || '',
        example_tweet_ids: topic.exampleTweetIds || [],
        detected_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('hot_topics')
        .insert(records);

    if (error) {
        console.error('[DB] Error saving hot topics:', error);
        throw error;
    }

    console.log(`[DB] Saved ${records.length} hot topics for category: ${category}`);
}

/**
 * Get the most recent topic names for context in the next analysis.
 */
export async function getRecentTopicNames(category: string): Promise<string[]> {
    const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // last 2 hours

    const { data } = await supabase
        .from('hot_topics')
        .select('topic_name')
        .eq('category', category)
        .gte('detected_at', since)
        .order('confidence_score', { ascending: false })
        .limit(10);

    return data?.map(t => t.topic_name) || [];
}

/**
 * Update influencer average engagement rates.
 * Should be run periodically (e.g., daily) to keep baselines accurate.
 */
export async function updateInfluencerAverages() {
    // Get all influencers
    const { data: influencers } = await supabase
        .from('influencers')
        .select('id, twitter_id');

    if (!influencers) return;

    for (const influencer of influencers) {
        // Get mean engagement rate from last 50 tweets
        const { data: snapshots } = await supabase
            .from('engagement_snapshots')
            .select('engagement_rate, tweet_id')
            .eq('tweets.influencer_id', influencer.id)
            .order('snapshot_at', { ascending: false })
            .limit(50);

        if (snapshots && snapshots.length > 0) {
            const avgRate = snapshots.reduce(
                (sum: number, s: any) => sum + (s.engagement_rate || 0), 0
            ) / snapshots.length;

            await supabase
                .from('influencers')
                .update({ avg_engagement_rate: Math.round(avgRate * 100) / 100 })
                .eq('id', influencer.id);
        }
    }

    console.log(`[DB] Updated average engagement rates for ${influencers.length} influencers`);
}
