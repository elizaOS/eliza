-- Rollback Migration: Remove materialized views for interaction count aggregations

-- Drop functions
DROP FUNCTION IF EXISTS refresh_trending_views();
DROP FUNCTION IF EXISTS refresh_interaction_views();

-- Drop materialized views
DROP MATERIALIZED VIEW IF EXISTS mv_comment_counts;
DROP MATERIALIZED VIEW IF EXISTS mv_trending_posts;
DROP MATERIALIZED VIEW IF EXISTS mv_user_stats;
DROP MATERIALIZED VIEW IF EXISTS mv_post_interaction_counts;
