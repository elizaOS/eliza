-- Rollback: Remove Milady Sandboxes tables
-- Run this to undo migration 0029_add_milady_sandboxes.sql

DROP TABLE IF EXISTS "milady_sandbox_backups";
DROP TABLE IF EXISTS "milady_sandboxes";
