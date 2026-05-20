-- Migration: Add materialized views for interaction count aggregations
-- Purpose: Pre-compute frequently accessed counts to reduce query load at 400k+ scale
--
-- These materialized views cache aggregated counts that would otherwise require
-- expensive COUNT(*) GROUP BY queries on every feed request.
--
-- Refresh strategy: These should be refreshed periodically (every 30s - 1min)
-- or via triggers on the underlying tables.

-- ============================================================================
-- Step 1: Post Interaction Counts Materialized View
-- ============================================================================

-- This view pre-aggregates like, comment, and share counts per post
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_post_interaction_counts AS
SELECT 
    p.id AS post_id,
    p.timestamp AS post_timestamp,
    COALESCE(r.like_count, 0) AS like_count,
    COALESCE(c.comment_count, 0) AS comment_count,
    COALESCE(s.share_count, 0) AS share_count,
    COALESCE(r.like_count, 0) + COALESCE(c.comment_count, 0) * 2 + COALESCE(s.share_count, 0) * 3 AS engagement_score,
    NOW() AS last_refreshed
FROM "Post" p
LEFT JOIN (
    SELECT "postId", COUNT(*) AS like_count
    FROM "Reaction"
    WHERE type = 'like' AND "postId" IS NOT NULL
    GROUP BY "postId"
) r ON p.id = r."postId"
LEFT JOIN (
    SELECT "postId", COUNT(*) AS comment_count
    FROM "Comment"
    WHERE "deletedAt" IS NULL
    GROUP BY "postId"
) c ON p.id = c."postId"
-- NOTE: Share table intentionally has no soft-delete (deletedAt) column.
-- Shares are permanent records of user actions - once shared, it remains in history.
-- This is a business decision: shares represent historical engagement metrics.
-- If soft-delete is added to Share in the future, update this query to filter.
LEFT JOIN (
    SELECT "postId", COUNT(*) AS share_count
    FROM "Share"
    GROUP BY "postId"
) s ON p.id = s."postId"
WHERE p."deletedAt" IS NULL;

-- Index for fast lookups by post_id
CREATE UNIQUE INDEX IF NOT EXISTS mv_post_interaction_counts_post_id_idx 
    ON mv_post_interaction_counts (post_id);

-- Index for sorting by engagement (for trending feeds)
CREATE INDEX IF NOT EXISTS mv_post_interaction_counts_engagement_idx 
    ON mv_post_interaction_counts (engagement_score DESC);

-- Index for time-based queries (recent posts with engagement)
CREATE INDEX IF NOT EXISTS mv_post_interaction_counts_timestamp_idx 
    ON mv_post_interaction_counts (post_timestamp DESC);

-- ============================================================================
-- Step 2: User Stats Materialized View
-- ============================================================================

-- This view pre-aggregates user statistics (followers, following, posts, etc.)
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_user_stats AS
SELECT 
    u.id AS user_id,
    COALESCE(followers.count, 0) AS followers_count,
    COALESCE(following.count, 0) AS following_count,
    COALESCE(actor_follows.count, 0) AS actor_follows_count,
    COALESCE(posts_count.count, 0) AS posts_count,
    COALESCE(comments_count.count, 0) AS comments_count,
    COALESCE(reactions_count.count, 0) AS reactions_count,
    NOW() AS last_refreshed
FROM "User" u
LEFT JOIN (
    SELECT "followingId", COUNT(*) AS count
    FROM "Follow"
    GROUP BY "followingId"
) followers ON u.id = followers."followingId"
LEFT JOIN (
    SELECT "followerId", COUNT(*) AS count
    FROM "Follow"
    GROUP BY "followerId"
) following ON u.id = following."followerId"
LEFT JOIN (
    SELECT "userId", COUNT(*) AS count
    FROM "UserActorFollow"
    GROUP BY "userId"
) actor_follows ON u.id = actor_follows."userId"
LEFT JOIN (
    SELECT "authorId", COUNT(*) AS count
    FROM "Post"
    WHERE "deletedAt" IS NULL
    GROUP BY "authorId"
) posts_count ON u.id = posts_count."authorId"
LEFT JOIN (
    SELECT "authorId", COUNT(*) AS count
    FROM "Comment"
    WHERE "deletedAt" IS NULL
    GROUP BY "authorId"
) comments_count ON u.id = comments_count."authorId"
LEFT JOIN (
    SELECT "userId", COUNT(*) AS count
    FROM "Reaction"
    GROUP BY "userId"
) reactions_count ON u.id = reactions_count."userId";

-- Unique index for fast lookups
CREATE UNIQUE INDEX IF NOT EXISTS mv_user_stats_user_id_idx 
    ON mv_user_stats (user_id);

-- ============================================================================
-- Step 3: Trending Posts Materialized View (for hot/trending feeds)
-- ============================================================================

-- This view identifies trending posts based on recent engagement velocity
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_trending_posts AS
SELECT 
    p.id AS post_id,
    p."authorId" AS author_id,
    p.timestamp AS post_timestamp,
    p.content,
    -- Count interactions in last 24 hours for velocity
    COALESCE(recent_likes.count, 0) AS likes_24h,
    COALESCE(recent_comments.count, 0) AS comments_24h,
    COALESCE(recent_shares.count, 0) AS shares_24h,
    -- Trending score = recency-weighted engagement
    -- Higher weight for recent interactions, decaying over time
    (
        COALESCE(recent_likes.count, 0) * 1 +
        COALESCE(recent_comments.count, 0) * 2 +
        COALESCE(recent_shares.count, 0) * 3
    ) * EXP(-EXTRACT(EPOCH FROM (NOW() - p.timestamp)) / 86400) AS trending_score,
    NOW() AS last_refreshed
FROM "Post" p
LEFT JOIN (
    SELECT "postId", COUNT(*) AS count
    FROM "Reaction"
    WHERE type = 'like' 
        AND "postId" IS NOT NULL
        AND "createdAt" > NOW() - INTERVAL '24 hours'
    GROUP BY "postId"
) recent_likes ON p.id = recent_likes."postId"
LEFT JOIN (
    SELECT "postId", COUNT(*) AS count
    FROM "Comment"
    WHERE "deletedAt" IS NULL
        AND "createdAt" > NOW() - INTERVAL '24 hours'
    GROUP BY "postId"
) recent_comments ON p.id = recent_comments."postId"
LEFT JOIN (
    SELECT "postId", COUNT(*) AS count
    FROM "Share"
    WHERE "createdAt" > NOW() - INTERVAL '24 hours'
    GROUP BY "postId"
) recent_shares ON p.id = recent_shares."postId"
WHERE p."deletedAt" IS NULL
    AND p.timestamp > NOW() - INTERVAL '7 days'  -- Only consider posts from last 7 days
ORDER BY trending_score DESC
LIMIT 1000;  -- Top 1000 trending posts

-- REQUIRED: Unique index on post_id for REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS mv_trending_posts_post_id_idx 
    ON mv_trending_posts (post_id);

-- Index for trending score ordering
CREATE INDEX IF NOT EXISTS mv_trending_posts_score_idx 
    ON mv_trending_posts (trending_score DESC);

-- ============================================================================
-- Step 4: Comment Counts per Post (for fast comment count lookups)
-- ============================================================================

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_comment_counts AS
SELECT 
    c."postId" AS post_id,
    COUNT(*) AS total_count,
    COUNT(*) FILTER (WHERE c."parentCommentId" IS NULL) AS top_level_count,
    MAX(c."createdAt") AS last_comment_at,
    NOW() AS last_refreshed
FROM "Comment" c
WHERE c."deletedAt" IS NULL
GROUP BY c."postId";

CREATE UNIQUE INDEX IF NOT EXISTS mv_comment_counts_post_id_idx 
    ON mv_comment_counts (post_id);

-- ============================================================================
-- Step 5: Function to refresh materialized views
-- ============================================================================

-- Function to refresh all interaction count materialized views
CREATE OR REPLACE FUNCTION refresh_interaction_views()
RETURNS void AS $$
BEGIN
    -- Refresh concurrently to avoid locking (requires unique index)
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_post_interaction_counts;
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_user_stats;
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_comment_counts;
    -- mv_trending_posts refreshed less frequently (every 5 minutes)
END;
$$ LANGUAGE plpgsql;

-- Function to refresh trending posts view only
CREATE OR REPLACE FUNCTION refresh_trending_views()
RETURNS void AS $$
BEGIN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_trending_posts;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- Step 6: Schedule refresh (using pg_cron if available)
-- ============================================================================

-- Note: This requires pg_cron extension to be installed
-- If pg_cron is not available, use external scheduler (e.g., cron job calling SQL)

-- Schedule interaction views refresh every minute (*/1 = every 1 minute in cron syntax)
-- Note: pg_cron minimum granularity is 1 minute. For 30-second refresh, use application-level scheduler.
-- SELECT cron.schedule('refresh-interaction-views', '*/1 * * * *', 'SELECT refresh_interaction_views()');

-- Schedule trending views refresh every 5 minutes  
-- SELECT cron.schedule('refresh-trending-views', '*/5 * * * *', 'SELECT refresh_trending_views()');

-- ============================================================================
-- Usage Examples
-- ============================================================================

-- Instead of:
--   SELECT COUNT(*) FROM "Reaction" WHERE "postId" = 'xyz' AND type = 'like'
--   SELECT COUNT(*) FROM "Comment" WHERE "postId" = 'xyz'
--   SELECT COUNT(*) FROM "Share" WHERE "postId" = 'xyz'
--
-- Use:
--   SELECT like_count, comment_count, share_count 
--   FROM mv_post_interaction_counts 
--   WHERE post_id = 'xyz'

-- For multiple posts at once:
--   SELECT post_id, like_count, comment_count, share_count
--   FROM mv_post_interaction_counts
--   WHERE post_id = ANY(ARRAY['post1', 'post2', 'post3'])
