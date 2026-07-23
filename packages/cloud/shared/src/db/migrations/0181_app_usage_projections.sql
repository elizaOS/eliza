/**
 * Adds the durable claim used to project app debit events into usage counters
 * without making analytics part of monetary settlement.
 */

CREATE TABLE IF NOT EXISTS app_usage_projections (
  charge_transaction_id uuid PRIMARY KEY
    REFERENCES credit_transactions(id) ON DELETE CASCADE,
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  credits_used numeric(12, 6) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamp NOT NULL DEFAULT NOW(),
  projected_at timestamp,
  CONSTRAINT app_usage_projections_status_valid
    CHECK (
      status IN (
        'pending',
        'applied',
        'skipped_missing_app',
        'skipped_missing_user'
      )
    ),
  CONSTRAINT app_usage_projections_credits_nonnegative
    CHECK (credits_used >= 0)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS app_usage_projections_app_created_idx
ON app_usage_projections (app_id, created_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS app_usage_projections_status_created_idx
ON app_usage_projections (status, created_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS credit_transactions_app_usage_projection_source_idx
ON credit_transactions (created_at, id)
WHERE type = 'debit'
  AND metadata->>'appUsageProjectionVersion' = '1';
