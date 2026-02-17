/**
 * Tweet Scraping Job
 * 
 * Fetches the latest tweets from all configured Twitter lists,
 * stores them in Supabase, and takes engagement snapshots.
 * 
 * Runs every 5 minutes via cron.
 */

import { fetchListTweets, fetchListMembers, fetchTweetDetails } from '../services/rettiwt.service';
import {
    upsertInfluencers,
    storeTweets,
    takeEngagementSnapshots,
    getTweetsNeedingRefresh,
} from '../services/engagement.service';
import { config } from '../lib/config';

/**
 * Main scrape function. Iterates through all configured list IDs,
 * fetches tweets, and stores them.
 */
export async function runScrapeJob() {
    console.log('\n=== [SCRAPE JOB] Starting tweet scrape ===');
    console.log(`[SCRAPE] Time: ${new Date().toISOString()}`);
    console.log(`[SCRAPE] Lists to scrape: ${config.twitterListIds.length}`);

    for (const listId of config.twitterListIds) {
        try {
            console.log(`[SCRAPE] Fetching tweets from list: ${listId}`);

            // Fetch latest tweets from the list
            const tweets = await fetchListTweets(listId, 100);
            console.log(`[SCRAPE] Fetched ${tweets.length} tweets from list ${listId}`);

            if (tweets.length === 0) {
                console.log(`[SCRAPE] No tweets found for list ${listId}, skipping...`);
                continue;
            }

            // Store tweets and create initial snapshots
            await storeTweets(tweets);

            // Also take follow-up snapshots for tweets we've seen before
            await takeEngagementSnapshots(tweets);

            console.log(`[SCRAPE] Successfully processed list ${listId}`);
        } catch (error) {
            console.error(`[SCRAPE] Error scraping list ${listId}:`, error);
        }

        // Small delay between lists to avoid rate limiting
        await sleep(2000);
    }

    console.log('=== [SCRAPE JOB] Completed tweet fetching ===\n');

    // ── Refresh Engagement for Recent Grid ──
    await refreshRecentTweets();

    console.log('=== [SCRAPE JOB] Fully Completed ===\n');
}

/**
 * Refresh engagement metrics for recent tweets (posted in last 24h).
 * This ensures that tweets which fell off the "List Feed" but are still
 * going viral get their stats updated for analysis.
 */
async function refreshRecentTweets() {
    console.log('\n=== [REFRESH] Updating engagement for recent viral tweets ===');
    // Get candidate IDs (tweets < 24h old with decent engagement)
    const tweetIds = await getTweetsNeedingRefresh(24);
    console.log(`[REFRESH] Found ${tweetIds.length} tweets needing refresh.`);

    if (tweetIds.length === 0) return;

    // Process in small chunks to respect rate limits
    const CHUNK_SIZE = 3;
    let processed = 0;

    for (let i = 0; i < tweetIds.length; i += CHUNK_SIZE) {
        const chunk = tweetIds.slice(i, i + CHUNK_SIZE);
        const refreshedTweets = [];

        console.log(`[REFRESH] Processing chunk ${i / CHUNK_SIZE + 1}/${Math.ceil(tweetIds.length / CHUNK_SIZE)}...`);

        for (const id of chunk) {
            try {
                const details = await fetchTweetDetails(id);
                if (details) {
                    refreshedTweets.push(details);
                }
                // Delay per tweet to avoid burning API keys
                await sleep(500);
            } catch (error) {
                console.warn(`[REFRESH] Failed to refresh tweet ${id}:`, error);
            }
        }

        if (refreshedTweets.length > 0) {
            await takeEngagementSnapshots(refreshedTweets);
            processed += refreshedTweets.length;
        }

        // Pause between chunks
        await sleep(2000);
    }

    console.log(`[REFRESH] Successfully updated ${processed} tweets.`);
}

/**
 * Sync list members to the influencers table.
 * Should run less frequently (e.g., every few hours).
 */
export async function syncListMembers(category: string = 'AI') {
    console.log('\n=== [SYNC] Syncing list members ===');

    for (const listId of config.twitterListIds) {
        try {
            const members = await fetchListMembers(listId);
            console.log(`[SYNC] Fetched ${members.length} members from list ${listId}`);

            await upsertInfluencers(members, category);
        } catch (error) {
            console.error(`[SYNC] Error syncing list ${listId}:`, error);
        }

        await sleep(2000);
    }

    console.log('=== [SYNC] Completed ===\n');
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Allow running directly
if (require.main === module) {
    runScrapeJob()
        .then(() => console.log('Scrape job finished'))
        .catch(err => console.error('Scrape job failed:', err));
}
