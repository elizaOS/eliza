CREATE TABLE IF NOT EXISTS affiliate_payout_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id text NOT NULL,
  affiliate_code_id uuid NOT NULL,
  affiliate_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  amount numeric(18, 4) NOT NULL,
  description text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp NOT NULL DEFAULT NOW(),
  processed_at timestamp,
  ledger_entry_id uuid,
  last_error text,
  created_at timestamp NOT NULL DEFAULT NOW(),
  updated_at timestamp NOT NULL DEFAULT NOW(),
  CONSTRAINT affiliate_payout_outbox_amount_positive CHECK (amount > 0),
  CONSTRAINT affiliate_payout_outbox_source_canonical
    CHECK (
      source_id <> ''
      AND source_id !~ '^[[:space:]]'
      AND source_id !~ '[[:space:]]$'
    )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS affiliate_payout_outbox_source_uidx
ON affiliate_payout_outbox (source_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS affiliate_payout_outbox_pending_due_idx
ON affiliate_payout_outbox (next_attempt_at, created_at)
WHERE processed_at IS NULL;
