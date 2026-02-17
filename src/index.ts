/**
 * Hot Topics Tracker - Main Server Entry Point
 * 
 * Starts the Express API server and schedules cron jobs for:
 * - Tweet scraping (every 5 minutes)
 * - Topic analysis (every 30 minutes)
 * - List member sync (every 6 hours)
 */

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import { config } from './lib/config';
import { apiRouter } from './routes/api';
import { runScrapeJob, syncListMembers } from './jobs/scrape-tweets';
import { runAnalysisJob } from './jobs/analyze-topics';

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// API Routes
app.use('/api', apiRouter);

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
    });
});

// Start server
app.listen(config.port, () => {
    console.log(`\n🔥 Hot Topics Tracker Backend running on port ${config.port}`);
    console.log(`   Health: http://localhost:${config.port}/health`);
    console.log(`   API:    http://localhost:${config.port}/api`);
    console.log(`\n📋 Configuration:`);
    console.log(`   Lists: ${config.twitterListIds.length} configured`);
    console.log(`   Scrape interval: every ${config.scrapeIntervalMinutes} minutes`);
    console.log(`   Analysis interval: every ${config.analysisIntervalMinutes} minutes`);
    console.log('');
});

// ============================================================
// CRON JOBS — with mutex to prevent overlapping runs
// ============================================================

let isScraping = false;
let isAnalyzing = false;

// 1. Scrape tweets every N minutes (default: 5)
const scrapeSchedule = `*/${config.scrapeIntervalMinutes} * * * *`;
cron.schedule(scrapeSchedule, async () => {
    if (isScraping) {
        console.log('[CRON] Scrape job skipped — previous run still in progress');
        return;
    }
    isScraping = true;
    try {
        await runScrapeJob();
    } catch (error) {
        console.error('[CRON] Scrape job failed:', error);
    } finally {
        isScraping = false;
    }
});
console.log(`⏰ Scraping scheduled: every ${config.scrapeIntervalMinutes} minutes`);

// 2. Analyze topics every N minutes (default: 30)
const analysisSchedule = `*/${config.analysisIntervalMinutes} * * * *`;
cron.schedule(analysisSchedule, async () => {
    if (isAnalyzing) {
        console.log('[CRON] Analysis job skipped — previous run still in progress');
        return;
    }
    isAnalyzing = true;
    try {
        await runAnalysisJob('AI');
    } catch (error) {
        console.error('[CRON] Analysis job failed:', error);
    } finally {
        isAnalyzing = false;
    }
});
console.log(`⏰ Analysis scheduled: every ${config.analysisIntervalMinutes} minutes`);

// 3. Sync list members every 6 hours
cron.schedule('0 */6 * * *', async () => {
    try {
        await syncListMembers('AI');
    } catch (error) {
        console.error('[CRON] Member sync failed:', error);
    }
});
console.log(`⏰ Member sync scheduled: every 6 hours`);

// Run initial sync on startup (after a delay to let server start)
setTimeout(async () => {
    console.log('\n🚀 Running initial sync...');
    try {
        await syncListMembers('AI');

        isScraping = true;
        try {
            await runScrapeJob();
        } finally {
            isScraping = false;
        }

        // Wait a bit, then run first analysis (only if not already running from cron)
        setTimeout(async () => {
            if (isAnalyzing) {
                console.log('[STARTUP] Analysis skipped — cron job already running');
                return;
            }
            isAnalyzing = true;
            try {
                await runAnalysisJob('AI');
            } catch (error) {
                console.error('[STARTUP] Initial analysis failed:', error);
            } finally {
                isAnalyzing = false;
            }
        }, 10000);
    } catch (error) {
        console.error('[STARTUP] Initial sync/scrape failed:', error);
    }
}, 3000);

