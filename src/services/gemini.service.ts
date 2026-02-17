/**
 * Gemini AI Service - Topic Analysis
 * 
 * Uses Google's Gemini AI to analyze tweets and identify trending topics.
 * 
 * Production features:
 * - Model fallback chain (gemini-3-flash-preview → gemini-2.5-flash → gemini-2.5-flash-lite)
 * - Temperature 0 for deterministic, consistent outputs
 * - Exponential backoff retry on rate limits
 * - Enforces reuse of existing topic names for consistency across cycles
 * - Graceful degradation when all models hit quota
 */

import { GoogleGenerativeAI, SchemaType } from '@google/generative-ai';
import { config } from '../lib/config';

let genAI: GoogleGenerativeAI | null = null;

function getGenAI(): GoogleGenerativeAI {
    if (!genAI) {
        if (!config.geminiApiKey) {
            throw new Error('GEMINI_API_KEY is not set. Please add it to your .env file.');
        }
        genAI = new GoogleGenerativeAI(config.geminiApiKey);
    }
    return genAI;
}

// Model fallback chain — only confirmed working models
const MODEL_CHAIN = [
    'gemini-2.0-flash',         // Primary: Most reliable for JSON
    'gemini-3-flash-preview',   // Fallback: Powerful, needs high token limit
];

const MAX_RETRIES = 3;           // 3 attempts per model
const BASE_RETRY_DELAY_MS = 3000; // Longer delay for rate limit recovery

// Common schema for a Topic
const TOPIC_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        name: { type: SchemaType.STRING },
        summary: { type: SchemaType.STRING },
        category: { type: SchemaType.STRING },
        score: { type: SchemaType.NUMBER },
        status: { type: SchemaType.STRING, enum: ["emerging", "warming", "hot", "peak", "declining"] },
        influencerCount: { type: SchemaType.NUMBER },
        totalEngagement: { type: SchemaType.NUMBER },
        avgPerformanceMultiplier: { type: SchemaType.NUMBER },
        keywords: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        suggestedAngles: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        exampleTweetIds: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
        whyItMatters: { type: SchemaType.STRING },
        timeToAct: { type: SchemaType.STRING },
        contentIdeas: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    },
    required: ["name", "summary", "category", "score", "status", "influencerCount", "totalEngagement", "avgPerformanceMultiplier", "keywords", "suggestedAngles", "exampleTweetIds", "whyItMatters", "timeToAct", "contentIdeas"]
};

// Full API Response Schema
const ANALYSIS_SCHEMA = {
    type: SchemaType.OBJECT,
    properties: {
        hotTopics: { type: SchemaType.ARRAY, items: TOPIC_SCHEMA },
        emergingSignals: { type: SchemaType.ARRAY, items: TOPIC_SCHEMA },
        peakingTopics: { type: SchemaType.ARRAY, items: TOPIC_SCHEMA },
        categoryInsight: { type: SchemaType.STRING },
    },
    required: ["hotTopics", "emergingSignals", "peakingTopics", "categoryInsight"]
};

// Generation config with STRUCTURED OUTPUTS (Schema)
// maxOutputTokens set to 65536 to prevent truncation (gemini-3-flash-preview supports up to 65536)
const GENERATION_CONFIG = {
    temperature: 0,
    topP: 1,
    topK: 1,
    maxOutputTokens: 65536,
    responseMimeType: 'application/json' as const,
    responseSchema: ANALYSIS_SCHEMA,
};

export interface TweetForAnalysis {
    tweetId: string;
    content: string;
    authorUsername: string;
    authorFollowers: number;
    likes: number;
    retweets: number;
    replies: number;
    views: number;
    bookmarks: number;
    performanceMultiplier: number;
    engagementRate: number;
    postedAt: string;
    hashtags: string[];
    isRetweet: boolean;
}

export interface DetectedTopic {
    name: string;
    summary: string;
    category: string;
    score: number;
    status: 'emerging' | 'warming' | 'hot' | 'peak' | 'declining';
    influencerCount: number;
    totalEngagement: number;
    avgPerformanceMultiplier: number;
    keywords: string[];
    suggestedAngles: string[];
    exampleTweetIds: string[];
    whyItMatters: string;
    timeToAct: string;
    contentIdeas: string[];
}

export interface AnalysisResult {
    hotTopics: DetectedTopic[];
    emergingSignals: DetectedTopic[];
    peakingTopics: DetectedTopic[];
    categoryInsight: string;
    analyzedAt: string;
}

/**
 * Analyze tweets from a category and identify hot topics.
 * Uses Structured Outputs to guarantee valid JSON.
 */
export async function analyzeTopics(
    tweets: TweetForAnalysis[],
    category: string,
    recentTopics: string[] = []
): Promise<AnalysisResult> {
    const ai = getGenAI();

    // Filter out pure retweets
    let originalTweets = tweets.filter(t => !t.isRetweet);

    if (originalTweets.length === 0) {
        return {
            hotTopics: [],
            emergingSignals: [],
            peakingTopics: [],
            categoryInsight: 'No original tweets found in this analysis window.',
            analyzedAt: new Date().toISOString(),
        };
    }

    // Cap at 25 tweets (sorted by engagement) to keep output within token limits
    // This prevents JSON truncation by reducing how much the model needs to output
    if (originalTweets.length > 25) {
        originalTweets = originalTweets
            .sort((a, b) => (b.likes + b.retweets + b.replies) - (a.likes + a.retweets + a.replies))
            .slice(0, 25);
        console.log(`[Gemini] Capped to top 25 tweets by engagement (from ${tweets.length})`);
    }

    // Deduplicate previous topic names (remove near-duplicates)
    const dedupedPreviousTopics = deduplicateTopicNames(recentTopics);

    const prompt = buildAnalysisPrompt(originalTweets, category, dedupedPreviousTopics);

    console.log(`[Gemini] Sending ${originalTweets.length} tweets for analysis (${dedupedPreviousTopics.length} previous topics for context)`);

    // Try each model in the fallback chain
    for (let modelIndex = 0; modelIndex < MODEL_CHAIN.length; modelIndex++) {
        const modelName = MODEL_CHAIN[modelIndex];

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`[Gemini] Trying ${modelName} (attempt ${attempt}/${MAX_RETRIES})...`);

                // Create model instance with specific config for EACH attempt
                const model = ai.getGenerativeModel({
                    model: modelName,
                    generationConfig: {
                        ...GENERATION_CONFIG,
                        responseSchema: ANALYSIS_SCHEMA,
                        responseMimeType: 'application/json',
                    },
                });
                const result = await model.generateContent(prompt);

                // Check if output was truncated (finishReason !== 'STOP')
                const candidate = result.response.candidates?.[0];
                const finishReason = candidate?.finishReason;
                if (finishReason && finishReason !== 'STOP') {
                    console.warn(`[Gemini] ⚠️ Output truncated (finishReason: ${finishReason}). Retrying...`);
                    throw new Error(`Output truncated: finishReason=${finishReason}`);
                }

                const text = result.response.text();

                // Advanced JSON Parsing with Cleanup
                const parsed = tryParseJSON(text);
                parsed.analyzedAt = new Date().toISOString();

                console.log(`[Gemini] ✅ Analysis succeeded with ${modelName}`);
                return parsed;

            } catch (error: any) {
                const isQuotaError = isRateLimitOrQuotaError(error);
                const isLastAttempt = attempt === MAX_RETRIES;
                const isLastModel = modelIndex === MODEL_CHAIN.length - 1;

                if (isQuotaError && !isLastAttempt) {
                    const delay = BASE_RETRY_DELAY_MS * Math.pow(2, attempt - 1);
                    console.warn(
                        `[Gemini] ⚠️ ${modelName} rate limited. Retrying in ${delay / 1000}s...`
                    );
                    await sleep(delay);
                    continue;

                } else if (isQuotaError && isLastAttempt && !isLastModel) {
                    console.warn(
                        `[Gemini] 🔄 ${modelName} quota exhausted. Falling back to ${MODEL_CHAIN[modelIndex + 1]}...`
                    );
                    break;

                } else if (!isQuotaError) {
                    // Start simplified prompt retry logic for Parsing Errors
                    console.error(`[Gemini] Error with ${modelName}:`, error.message);
                }

                if (isQuotaError && isLastModel) {
                    // ... (Quota exhausted logic) ...
                    console.error(`[Gemini] ❌ All models exhausted.`);
                    return {
                        hotTopics: [],
                        emergingSignals: [],
                        peakingTopics: [],
                        categoryInsight: '⚠️ Gemini API quota exhausted.',
                        analyzedAt: new Date().toISOString(),
                    };
                }

                if (isLastAttempt && isLastModel) {
                    return {
                        hotTopics: [],
                        emergingSignals: [],
                        peakingTopics: [],
                        categoryInsight: `Analysis failed: ${error.message}`,
                        analyzedAt: new Date().toISOString(),
                    };
                }

                if (isLastAttempt) break;
                await sleep(BASE_RETRY_DELAY_MS);
            }
        }
    }

    return {
        hotTopics: [],
        emergingSignals: [],
        peakingTopics: [],
        categoryInsight: 'Analysis could not be completed.',
        analyzedAt: new Date().toISOString(),
    };
}

/**
 * Robust JSON parser that attempts to fix common Gemini syntax errors.
 */
function tryParseJSON(text: string): AnalysisResult {
    let jsonStr = text;
    // Extract from markdown block if present
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
    }

    try {
        return JSON.parse(jsonStr) as AnalysisResult;
    } catch (e) {
        // Fix 1: Quote unquoted keys (e.g. { name: "foo" } -> { "name": "foo" })
        // Look for word characters followed by colon, not inside quotes
        let fixed = jsonStr.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');

        // Fix 2: Remove trailing commas
        fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

        try {
            return JSON.parse(fixed) as AnalysisResult;
        } catch (e2) {
            console.error('[Gemini] JSON parse failed even after cleanup:', e2);
            throw e; // Throw original error
        }
    }
}

// ============================================================
// PROMPT BUILDER
// ============================================================

function buildAnalysisPrompt(
    tweets: TweetForAnalysis[],
    category: string,
    recentTopics: string[]
): string {
    const tweetData = tweets.map(t => ({
        id: t.tweetId,
        text: t.content,
        author: `@${t.authorUsername} (${formatFollowers(t.authorFollowers)} followers)`,
        engagement: {
            likes: t.likes,
            retweets: t.retweets,
            replies: t.replies,
            views: t.views,
            performanceMultiplier: Math.round(t.performanceMultiplier * 100) / 100,
            engagementRate: Math.round(t.engagementRate * 100) / 100,
        },
        hashtags: t.hashtags,
        postedAt: t.postedAt,
    }));

    // Build the previous topics section with STRICT reuse instructions
    let previousTopicsSection = '';
    if (recentTopics.length > 0) {
        previousTopicsSection = `
## ⚠️ PREVIOUSLY DETECTED TOPICS (REUSE THESE NAMES EXACTLY)
The following topics were detected in the previous analysis cycle. If any of these topics are still relevant in the current tweets, you MUST reuse the EXACT same topic name. Do NOT rephrase, reword, or create variations.

Previous topics:
${recentTopics.map((t, i) => `${i + 1}. "${t}"`).join('\n')}

RULES:
- If "Seedance 2.0" was a previous topic and tweets still discuss it → use "Seedance 2.0" again
- Do NOT create variations like "The Seedance Debate" or "Unfiltered Video Generation"
- Only create a NEW topic name if the tweets discuss something genuinely new
- You may update the score/status of an existing topic, but keep the name identical
`;
    }

    return `You are an expert ${category} trend analyst. Analyze these tweets and identify trending topics with EXACT precision and CONSISTENT naming.

## CONTEXT
- Category: ${category}
- Total tweets: ${tweets.length}
- Time: ${new Date().toISOString()}
- Source: Curated list of 100+ top ${category} influencers on X/Twitter
${previousTopicsSection}

## TWEET DATA
${JSON.stringify(tweetData, null, 2)}

## METRICS EXPLANATION
- **performanceMultiplier**: Tweet performance vs. expected (1.0=normal, 2.0=2x better, 3.0+=viral)
- **engagementRate**: (interactions / followers) * 100
- Multiple influencers on same topic = strong trend signal
- A topic needs 2+ independent influencers to be considered genuine

## ANALYSIS RULES

1. **SPECIFIC topic names** — NOT generic. Give exact, googleable names.
   ❌ BAD: "AI developments", "tech news", "video generation tools"
   ✅ GOOD: "Seedance 2.0", "Agent2Agent Protocol", "PyTorch Foundation Reorg"

2. **CONSISTENT naming** — If a topic appeared before, reuse the EXACT same name.

3. **Score 0-100** strictly based on DATA, not opinion:
   - 2-3 influencers discussing = 40-60
   - 4-6 influencers with moderate engagement = 60-80
   - 7+ influencers with high performanceMultiplier = 80-95
   - Only score 95+ if massive viral signal across 10+ influencers

4. **Status classification** (based on data, not guessing):
   - "emerging" = 1-2 influencers, performanceMultiplier > 2.0
   - "warming" = 3-5 influencers starting to discuss
   - "hot" = 6+ influencers, avg performanceMultiplier > 1.5
   - "peak" = was hot last cycle, still high but engagement plateauing
   - "declining" = was hot/peak, engagement or influencer count dropping

5. **Actionable suggestions** — Give specific content angles, not generic advice.

6. **exampleTweetIds** — Include the actual tweet IDs from the data above that discuss this topic.
`;
}

// ============================================================
// HELPERS
// ============================================================

/**
 * Deduplicate near-similar topic names using simple substring matching.
 * e.g., "Seedance 2.0", "Seedance 2.0 Debate", "Unfiltered Video (Seedance 2.0)"
 * → keeps only the shortest, most canonical form.
 */
function deduplicateTopicNames(topics: string[]): string[] {
    if (topics.length === 0) return [];

    // Normalize for comparison
    const normalized = topics.map(t => ({
        original: t,
        lower: t.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim(),
        words: new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/)),
    }));

    const kept: typeof normalized = [];

    for (const topic of normalized) {
        // Check if this topic is a near-duplicate of one we already kept
        const isDuplicate = kept.some(existing => {
            // Calculate word overlap
            const intersection = [...topic.words].filter(w => existing.words.has(w));
            const overlapRatio = intersection.length / Math.min(topic.words.size, existing.words.size);
            // If 60%+ of the shorter name's words overlap → duplicate
            return overlapRatio >= 0.6;
        });

        if (!isDuplicate) {
            kept.push(topic);
        }
    }

    return kept.map(k => k.original);
}

function isRateLimitOrQuotaError(error: any): boolean {
    const message = (error.message || '').toLowerCase();
    const status = error.status || error.statusCode;
    return (
        status === 429 ||
        message.includes('rate limit') ||
        message.includes('quota') ||
        message.includes('too many requests') ||
        message.includes('resource has been exhausted')
    );
}

function formatFollowers(count: number): string {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
    return count.toString();
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
