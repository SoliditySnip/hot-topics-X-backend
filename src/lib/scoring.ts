/**
 * Engagement Scoring System
 * 
 * Calculates how well a tweet is performing relative to the influencer's
 * follower count. This normalizes engagement across differently-sized accounts.
 */

export interface EngagementMetrics {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    views: number;
    bookmarks: number;
}

export interface ScoredTweet {
    tweetId: string;
    engagementRate: number;        // Total engagement / followers * 100
    performanceMultiplier: number; // How much above average this tweet is
    velocityScore: number;         // Engagement per minute since posting
    normalizedScore: number;       // Final combined score (0-100)
}

/**
 * Expected engagement rates by follower tier.
 * Based on industry benchmarks for Twitter/X.
 * Format: { minFollowers: expectedEngagementRatePercent }
 */
const EXPECTED_RATES: { min: number; max: number; rate: number }[] = [
    { min: 0, max: 1000, rate: 8.0 },   // Nano: high relative engagement
    { min: 1000, max: 10000, rate: 4.0 },   // Micro
    { min: 10000, max: 100000, rate: 2.0 },   // Mid
    { min: 100000, max: 1000000, rate: 1.2 },   // Macro
    { min: 1000000, max: Infinity, rate: 0.7 },   // Mega
];

/**
 * Get the expected engagement rate for a given follower count.
 */
function getExpectedRate(followerCount: number): number {
    const tier = EXPECTED_RATES.find(t => followerCount >= t.min && followerCount < t.max);
    return tier ? tier.rate : 1.0;
}

/**
 * Calculate the engagement rate for a tweet.
 * Formula: (likes + retweets + replies + quotes + bookmarks) / followerCount * 100
 */
export function calculateEngagementRate(
    metrics: EngagementMetrics,
    followerCount: number
): number {
    if (followerCount === 0) return 0;

    const totalEngagement = metrics.likes + metrics.retweets + metrics.replies +
        metrics.quotes + metrics.bookmarks;
    return (totalEngagement / followerCount) * 100;
}

/**
 * Calculate the performance multiplier.
 * This tells us how much better (or worse) this tweet is doing compared to
 * what we'd expect for an account of this size.
 * 
 * multiplier = actualRate / expectedRate
 * 1.0 = normal, 2.0 = 2x better than expected, 0.5 = half of expected
 */
export function calculatePerformanceMultiplier(
    engagementRate: number,
    followerCount: number,
    influencerAvgRate?: number
): number {
    // If we have the influencer's own historical average, use it for more accuracy
    const expectedRate = influencerAvgRate || getExpectedRate(followerCount);
    if (expectedRate === 0) return 0;
    return engagementRate / expectedRate;
}

/**
 * Calculate engagement velocity (engagement per minute since posting).
 * Early high velocity = strong signal of trending content.
 */
export function calculateVelocityScore(
    metrics: EngagementMetrics,
    minutesSincePost: number,
    followerCount: number
): number {
    if (minutesSincePost <= 0 || followerCount === 0) return 0;

    const totalEngagement = metrics.likes + metrics.retweets + metrics.replies +
        metrics.quotes + metrics.bookmarks;
    const engagementPerMinute = totalEngagement / minutesSincePost;

    // Normalize by follower count (per 1000 followers)
    return (engagementPerMinute / (followerCount / 1000));
}

/**
 * Calculate the final normalized score (0-100).
 * Combines engagement rate, performance multiplier, and velocity.
 */
export function calculateNormalizedScore(
    performanceMultiplier: number,
    velocityScore: number,
    minutesSincePost: number
): number {
    // Weight velocity more for recent posts, performance more for older posts
    const recencyFactor = Math.max(0, 1 - (minutesSincePost / (24 * 60))); // Decays over 24h

    // Performance score (0-50 range, capped)
    const perfScore = Math.min(50, performanceMultiplier * 15);

    // Velocity score (0-30 range, weighted by recency)
    const velScore = Math.min(30, velocityScore * 5 * recencyFactor);

    // Recency bonus (0-20 range)
    const recencyBonus = recencyFactor * 20;

    return Math.min(100, Math.round(perfScore + velScore + recencyBonus));
}

/**
 * Full scoring pipeline for a single tweet.
 */
export function scoreTweet(
    metrics: EngagementMetrics,
    followerCount: number,
    minutesSincePost: number,
    influencerAvgRate?: number
): ScoredTweet {
    const engagementRate = calculateEngagementRate(metrics, followerCount);
    const performanceMultiplier = calculatePerformanceMultiplier(
        engagementRate, followerCount, influencerAvgRate
    );
    const velocityScore = calculateVelocityScore(metrics, minutesSincePost, followerCount);
    const normalizedScore = calculateNormalizedScore(
        performanceMultiplier, velocityScore, minutesSincePost
    );

    return {
        tweetId: '',
        engagementRate,
        performanceMultiplier,
        velocityScore,
        normalizedScore,
    };
}
