-- Rollback: Remove Eliza Sandboxes tables
-- Run this to undo migration 0029_add_eliza_sandboxes.sql

DROP TABLE IF EXISTS "eliza_sandbox_backups";
DROP TABLE IF EXISTS "eliza_sandboxes";
