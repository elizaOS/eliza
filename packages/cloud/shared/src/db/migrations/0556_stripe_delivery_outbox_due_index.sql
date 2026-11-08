-- migrate-with-diagnostics: nontransactional-concurrent-indexes
-- Lets the cron find due Stripe deliveries without a lock on the hot webhook table.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "webhook_events_delivery_due_idx"
  ON "webhook_events" ("delivery_next_attempt_at")
  WHERE "delivery_payload" IS NOT NULL
    AND "delivery_completed_at" IS NULL
    AND "delivery_dead_lettered_at" IS NULL;
