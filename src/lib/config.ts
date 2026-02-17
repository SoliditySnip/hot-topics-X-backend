import dotenv from 'dotenv';
dotenv.config();

export const config = {
    // Rettiwt - multiple API keys (comma-separated)
    rettiwtApiKeys: process.env.RETTIWT_API_KEYS || '',

    // Supabase
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY || '',

    // Gemini
    geminiApiKey: process.env.GEMINI_API_KEY || '',

    // Twitter List IDs
    twitterListIds: (process.env.TWITTER_LIST_IDS || '').split(',').filter(Boolean),

    // Server
    port: parseInt(process.env.PORT || '3001', 10),

    // Intervals
    scrapeIntervalMinutes: parseInt(process.env.SCRAPE_INTERVAL_MINUTES || '5', 10),
    analysisIntervalMinutes: parseInt(process.env.ANALYSIS_INTERVAL_MINUTES || '30', 10),
    snapshotIntervalMinutes: parseInt(process.env.SNAPSHOT_INTERVAL_MINUTES || '15', 10),
};
