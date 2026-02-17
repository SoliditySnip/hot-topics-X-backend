/**
 * Topic Analysis Job
 * 
 * Collects recent tweets with engagement data, sends them to Gemini AI,
 * and saves the detected hot topics.
 * 
 * Runs every 30 minutes via cron.
 */

import {
    getRecentTweetsForAnalysis,
    saveHotTopics,
    getRecentTopicNames,
} from '../services/engagement.service';
import { analyzeTopics } from '../services/gemini.service';

/**
 * Main analysis function.
 * Gathers recent tweets, runs them through Gemini, and saves results.
 */
export async function runAnalysisJob(category: string = 'AI') {
    console.log('\n=== [ANALYSIS JOB] Starting topic analysis ===');
    console.log(`[ANALYSIS] Time: ${new Date().toISOString()}`);
    console.log(`[ANALYSIS] Category: ${category}`);

    try {
        // 1. Get recent tweets with engagement data
        const tweets = await getRecentTweetsForAnalysis(category, 6);
        console.log(`[ANALYSIS] Found ${tweets.length} tweets for analysis`);

        if (tweets.length < 3) {
            console.log('[ANALYSIS] Not enough tweets for meaningful analysis. Skipping...');
            return;
        }

        // 2. Get recent topic names for context continuity
        const recentTopics = await getRecentTopicNames(category);
        console.log(`[ANALYSIS] Previous topics for context: ${recentTopics.join(', ') || 'none'}`);

        // 3. Run Gemini analysis
        console.log('[ANALYSIS] Sending data to Gemini for analysis...');
        const result = await analyzeTopics(tweets, category, recentTopics);

        // 4. Save all detected topics
        const allTopics = [
            ...result.hotTopics,
            ...result.emergingSignals,
            ...result.peakingTopics,
        ];

        if (allTopics.length > 0) {
            await saveHotTopics(allTopics, category);
            console.log(`[ANALYSIS] Detected ${allTopics.length} topics:`);

            for (const topic of allTopics) {
                const emoji = topic.status === 'hot' ? '🔥' :
                    topic.status === 'warming' ? '🟠' :
                        topic.status === 'peak' ? '📈' :
                            topic.status === 'emerging' ? '🟡' : '📉';
                console.log(`  ${emoji} [${topic.status.toUpperCase()}] ${topic.name} (score: ${topic.score})`);
            }
        } else {
            console.log('[ANALYSIS] No significant topics detected in this cycle.');
        }

        if (result.categoryInsight) {
            console.log(`[ANALYSIS] Category insight: ${result.categoryInsight}`);
        }

    } catch (error) {
        console.error('[ANALYSIS] Error running analysis:', error);
    }

    console.log('=== [ANALYSIS JOB] Completed ===\n');
}

// Allow running directly
if (require.main === module) {
    const category = process.argv[2] || 'AI';
    runAnalysisJob(category)
        .then(() => console.log('Analysis job finished'))
        .catch(err => console.error('Analysis job failed:', err));
}
