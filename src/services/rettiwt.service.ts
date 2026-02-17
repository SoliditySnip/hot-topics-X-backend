/**
 * Rettiwt Service - Twitter/X Data Fetching
 * 
 * Uses the Rettiwt-API library to scrape tweets from Twitter lists.
 * Now powered by the KeyPoolManager for production-grade key rotation,
 * automatic failover on rate limits, and health monitoring.
 */

import { config } from '../lib/config';
import { keyPool } from '../lib/key-pool';

// Initialize key pool on first import
keyPool.initialize(config.rettiwtApiKeys);

/**
 * Fetch tweets from a Twitter list.
 * Automatically rotates API keys on rate limit errors.
 */
export async function fetchListTweets(listId: string, count: number = 100) {
    const response = await keyPool.execute(
        (rettiwt) => rettiwt.list.tweets(listId, count),
        `list.tweets(${listId})`
    );

    return response.list.map((tweet: any) => ({
        tweetId: tweet.id,
        content: tweet.fullText,
        postedAt: tweet.createdAt,
        lang: tweet.lang,
        url: `https://x.com/${tweet.tweetBy?.userName}/status/${tweet.id}`,

        // Author info
        authorId: tweet.tweetBy?.id || '',
        authorUsername: tweet.tweetBy?.userName || '',
        authorDisplayName: tweet.tweetBy?.fullName || '',
        authorFollowers: tweet.tweetBy?.followersCount || 0,
        authorIsVerified: tweet.tweetBy?.isVerified || false,
        authorProfileImage: tweet.tweetBy?.profileImage || '',

        // Engagement metrics
        likes: tweet.likeCount || 0,
        retweets: tweet.retweetCount || 0,
        replies: tweet.replyCount || 0,
        quotes: tweet.quoteCount || 0,
        views: tweet.viewCount || 0,
        bookmarks: tweet.bookmarkCount || 0,

        // Entities
        hashtags: tweet.entities?.hashtags || [],
        mentionedUsers: tweet.entities?.mentionedUsers || [],
        urls: tweet.entities?.urls || [],

        // Tweet type flags
        isRetweet: !!tweet.retweetedTweet,
        isReply: !!tweet.replyTo,
        isQuote: !!tweet.quoted,

        // The original retweeted content (if this is a RT)
        retweetedContent: tweet.retweetedTweet?.fullText || null,
        retweetedAuthor: tweet.retweetedTweet?.tweetBy?.userName || null,

        // The quoted tweet content (if this is a QT)
        quotedContent: tweet.quoted?.fullText || null,
        quotedAuthor: tweet.quoted?.tweetBy?.userName || null,
    }));
}

/**
 * Fetch members of a Twitter list.
 * Automatically rotates API keys on rate limit errors.
 */
export async function fetchListMembers(listId: string) {
    const response = await keyPool.execute(
        (rettiwt) => rettiwt.list.members(listId, 100),
        `list.members(${listId})`
    );

    return response.list.map((user: any) => ({
        twitterId: user.id,
        username: user.userName,
        displayName: user.fullName,
        followerCount: user.followersCount || 0,
        isVerified: user.isVerified || false,
        description: user.description || '',
        profileImage: user.profileImage || '',
        statusesCount: user.statusesCount || 0,
    }));
}

/**
 * Fetch a single user's details.
 */
export async function fetchUserDetails(username: string) {
    const user = await keyPool.execute(
        (rettiwt) => rettiwt.user.details(username),
        `user.details(${username})`
    ) as any;

    if (!user) return null;

    return {
        twitterId: user.id,
        username: user.userName,
        displayName: user.fullName,
        followerCount: user.followersCount || 0,
        isVerified: user.isVerified || false,
        description: user.description || '',
        profileImage: user.profileImage || '',
        statusesCount: user.statusesCount || 0,
    };
}

/**
 * Fetch a single tweet's details by ID.
 * Used for refreshing engagement on older tweets.
 */
export async function fetchTweetDetails(tweetId: string) {
    const tweet = await keyPool.execute(
        (rettiwt) => rettiwt.tweet.details(tweetId),
        `tweet.details(${tweetId})`
    ) as any;

    if (!tweet) return null;

    return {
        tweetId: tweet.id,
        content: tweet.fullText,
        postedAt: tweet.createdAt,
        lang: tweet.lang,
        url: `https://x.com/${tweet.tweetBy?.userName}/status/${tweet.id}`,

        // Author info
        authorId: tweet.tweetBy?.id || '',
        authorUsername: tweet.tweetBy?.userName || '',
        authorDisplayName: tweet.tweetBy?.fullName || '',
        authorFollowers: tweet.tweetBy?.followersCount || 0,
        authorIsVerified: tweet.tweetBy?.isVerified || false,
        authorProfileImage: tweet.tweetBy?.profileImage || '',

        // Engagement metrics
        likes: tweet.likeCount || 0,
        retweets: tweet.retweetCount || 0,
        replies: tweet.replyCount || 0,
        quotes: tweet.quoteCount || 0,
        views: tweet.viewCount || 0,
        bookmarks: tweet.bookmarkCount || 0,

        // Entities
        hashtags: tweet.entities?.hashtags || [],
        mentionedUsers: tweet.entities?.mentionedUsers || [],
        urls: tweet.entities?.urls || [],

        // Tweet type flags
        isRetweet: !!tweet.retweetedTweet,
        isReply: !!tweet.replyTo,
        isQuote: !!tweet.quoted,

        // The original retweeted content (if this is a RT)
        retweetedContent: tweet.retweetedTweet?.fullText || null,
        retweetedAuthor: tweet.retweetedTweet?.tweetBy?.userName || null,

        // The quoted tweet content (if this is a QT)
        quotedContent: tweet.quoted?.fullText || null,
        quotedAuthor: tweet.quoted?.tweetBy?.userName || null,
    };
}

export type FetchedTweet = Awaited<ReturnType<typeof fetchListTweets>>[number];
export type FetchedUser = Awaited<ReturnType<typeof fetchListMembers>>[number];

