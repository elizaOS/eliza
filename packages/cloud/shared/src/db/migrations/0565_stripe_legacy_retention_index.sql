-- migrate-with-diagnostics: nontransactional-concurrent-indexes
-- Retained legacy receipts can be old indefinitely. Cleanup should only scan
-- rows it is allowed to remove, without locking webhook intake during build.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_unretained_processed_idx"
  ON "webhook_events" ("processed_at")
  WHERE "delivery_legacy_retained" = false;
