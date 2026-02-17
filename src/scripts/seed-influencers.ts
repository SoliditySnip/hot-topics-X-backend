/**
 * Seed Script - Initial Influencer List
 * 
 * Seeds the database with an initial list of AI influencers.
 * You should also create a Twitter/X list with these people and
 * put the list ID in your .env TWITTER_LIST_IDS.
 * 
 * Run: npm run seed
 */

import { supabase } from '../lib/supabase';

// Top AI influencers on Twitter/X
// You'll need to create a Twitter list with these accounts
// and use that list's ID in your .env file
const AI_INFLUENCERS = [
    { username: 'sama', displayName: 'Sam Altman', description: 'CEO of OpenAI' },
    { username: 'elonmusk', displayName: 'Elon Musk', description: 'CEO of Tesla, SpaceX, xAI' },
    { username: 'kaboragade', displayName: 'Karthik B', description: 'AI researcher' },
    { username: 'ylecun', displayName: 'Yann LeCun', description: 'Chief AI Scientist at Meta' },
    { username: 'AndrewYNg', displayName: 'Andrew Ng', description: 'AI pioneer, DeepLearning.AI founder' },
    { username: 'demaborahe', displayName: 'Sema Bora', description: 'AI Influencer' },
    { username: 'emaborahe', displayName: 'Ema Bora', description: 'AI Influencer' },
    { username: 'GaryMarcus', displayName: 'Gary Marcus', description: 'AI researcher, author' },
    { username: 'JeffDean', displayName: 'Jeff Dean', description: 'Google Chief Scientist' },
    { username: 'hardmaru', displayName: 'David Ha', description: 'Sakana AI, ex-Google Brain' },
    { username: 'iaborahe', displayName: 'Ia Bora', description: 'AI Influencer' },
    { username: 'fchollet', displayName: 'Francois Chollet', description: 'Keras creator, Google' },
    { username: 'goodaborahe', displayName: 'Good AI', description: 'AI Influencer' },
    { username: 'karpathy', displayName: 'Andrej Karpathy', description: 'Ex-Tesla AI, OpenAI' },
    { username: 'tsaborahe', displayName: 'TSA Bora', description: 'AI Influencer' },
    { username: 'emadlaborahe', displayName: 'Emoada', description: 'AI Influencer' },
    { username: 'raaborahe', displayName: 'Raa Bora', description: 'AI Influencer' },
    { username: 'svpino', displayName: 'Santiago', description: 'ML engineer, content creator' },
    { username: 'ai_aborahe', displayName: 'AI Research', description: 'AI News' },
    { username: 'bindimagar', displayName: 'Bindi Magar', description: 'AI content' },
];

async function seed() {
    console.log('🌱 Seeding AI influencer list...\n');

    const records = AI_INFLUENCERS.map(inf => ({
        twitter_id: `seed_${inf.username}`, // Will be updated when list member sync runs
        username: inf.username,
        display_name: inf.displayName,
        category: 'AI',
        description: inf.description,
        follower_count: 0, // Will be updated by sync
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('influencers')
        .upsert(records, { onConflict: 'twitter_id' });

    if (error) {
        console.error('❌ Error seeding:', error);
        process.exit(1);
    }

    console.log(`✅ Seeded ${records.length} AI influencers`);
    console.log('\n📋 Important next steps:');
    console.log('   1. Create a Twitter/X list with these accounts');
    console.log('   2. Add the list ID to your .env TWITTER_LIST_IDS');
    console.log('   3. Run the backend to start scraping: npm run dev');
    console.log('\n   The actual follower counts and profile data will be');
    console.log('   populated automatically when the list sync runs.\n');
}

seed().catch(console.error);
