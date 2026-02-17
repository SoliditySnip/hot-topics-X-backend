-- ============================================================
-- HOT TOPICS TRACKER - SUPABASE DATABASE MIGRATION
-- ============================================================
-- Run this SQL in your Supabase SQL Editor to set up all tables.
-- Go to: Supabase Dashboard > SQL Editor > New Query > Paste & Run
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- 1. INFLUENCERS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS influencers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  twitter_id VARCHAR NOT NULL UNIQUE,
  username VARCHAR NOT NULL,
  display_name VARCHAR,
  follower_count INTEGER DEFAULT 0,
  category VARCHAR NOT NULL DEFAULT 'AI',
  is_verified BOOLEAN DEFAULT FALSE,
  description TEXT,
  profile_image TEXT,
  statuses_count INTEGER DEFAULT 0,
  avg_engagement_rate DECIMAL DEFAULT 0,
  avg_likes_per_post INTEGER DEFAULT 0,
  avg_retweets_per_post INTEGER DEFAULT 0,
  last_scraped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_influencers_twitter_id ON influencers(twitter_id);
CREATE INDEX idx_influencers_category ON influencers(category);
CREATE INDEX idx_influencers_followers ON influencers(follower_count DESC);

-- ============================================================
-- 2. TWEETS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS tweets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tweet_id VARCHAR NOT NULL UNIQUE,
  influencer_id UUID REFERENCES influencers(id) ON DELETE SET NULL,
  content TEXT NOT NULL,
  posted_at TIMESTAMPTZ NOT NULL,
  author_username VARCHAR,
  author_followers INTEGER DEFAULT 0,
  
  -- Extracted data
  hashtags TEXT[] DEFAULT '{}',
  keywords TEXT[] DEFAULT '{}',
  
  -- Tweet metadata
  is_retweet BOOLEAN DEFAULT FALSE,
  is_reply BOOLEAN DEFAULT FALSE,
  is_quote BOOLEAN DEFAULT FALSE,
  url TEXT,
  lang VARCHAR DEFAULT 'en',
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tweets_tweet_id ON tweets(tweet_id);
CREATE INDEX idx_tweets_influencer_id ON tweets(influencer_id);
CREATE INDEX idx_tweets_posted_at ON tweets(posted_at DESC);
CREATE INDEX idx_tweets_is_retweet ON tweets(is_retweet);

-- ============================================================
-- 3. ENGAGEMENT SNAPSHOTS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS engagement_snapshots (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tweet_id UUID REFERENCES tweets(id) ON DELETE CASCADE,
  
  -- Raw metrics at this point in time
  likes INTEGER DEFAULT 0,
  retweets INTEGER DEFAULT 0,
  replies INTEGER DEFAULT 0,
  quotes INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  bookmarks INTEGER DEFAULT 0,
  
  -- Calculated metrics
  engagement_rate DECIMAL DEFAULT 0,
  performance_multiplier DECIMAL DEFAULT 1,
  velocity_score DECIMAL DEFAULT 0,
  normalized_score INTEGER DEFAULT 0,
  
  -- Timing
  minutes_after_post INTEGER DEFAULT 0,
  snapshot_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_snapshots_tweet_id ON engagement_snapshots(tweet_id);
CREATE INDEX idx_snapshots_snapshot_at ON engagement_snapshots(snapshot_at DESC);

-- ============================================================
-- 4. HOT TOPICS TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS hot_topics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Topic info
  topic_name VARCHAR NOT NULL,
  topic_summary TEXT,
  keywords TEXT[] DEFAULT '{}',
  category VARCHAR NOT NULL DEFAULT 'AI',
  
  -- Metrics
  influencer_count INTEGER DEFAULT 0,
  total_engagement INTEGER DEFAULT 0,
  avg_performance_multiplier DECIMAL DEFAULT 1,
  confidence_score INTEGER DEFAULT 0,
  
  -- Status: emerging, warming, hot, peak, declining
  status VARCHAR DEFAULT 'emerging',
  
  -- AI analysis results
  suggested_angles TEXT[] DEFAULT '{}',
  content_ideas TEXT[] DEFAULT '{}',
  why_it_matters TEXT,
  time_to_act TEXT,
  example_tweet_ids TEXT[] DEFAULT '{}',
  
  -- Timestamps
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  peaked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_topics_category ON hot_topics(category);
CREATE INDEX idx_topics_status ON hot_topics(status);
CREATE INDEX idx_topics_confidence ON hot_topics(confidence_score DESC);
CREATE INDEX idx_topics_detected_at ON hot_topics(detected_at DESC);

-- ============================================================
-- 5. TOPIC-TWEET JUNCTION TABLE
-- ============================================================
CREATE TABLE IF NOT EXISTS topic_tweets (
  topic_id UUID REFERENCES hot_topics(id) ON DELETE CASCADE,
  tweet_id UUID REFERENCES tweets(id) ON DELETE CASCADE,
  relevance_score DECIMAL DEFAULT 0,
  PRIMARY KEY (topic_id, tweet_id)
);

-- ============================================================
-- 6. ROW LEVEL SECURITY (RLS) - Enable public read access
-- ============================================================
ALTER TABLE influencers ENABLE ROW LEVEL SECURITY;
ALTER TABLE tweets ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE hot_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_tweets ENABLE ROW LEVEL SECURITY;

-- Allow public read access to all tables (for the frontend)
CREATE POLICY "Allow public read" ON influencers FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON tweets FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON engagement_snapshots FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON hot_topics FOR SELECT USING (true);
CREATE POLICY "Allow public read" ON topic_tweets FOR SELECT USING (true);

-- Allow service role full access (for the backend)
CREATE POLICY "Allow service role all" ON influencers FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role all" ON tweets FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role all" ON engagement_snapshots FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role all" ON hot_topics FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow service role all" ON topic_tweets FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- DONE! All tables are ready.
-- ============================================================
