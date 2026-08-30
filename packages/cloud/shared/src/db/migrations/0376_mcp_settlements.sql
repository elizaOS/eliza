-- First-committed-wins settlement authority for one MCP purchase (#22961).
--
-- The MCP proxy debits the buyer up front (reserveAndDeductCredits) and then
-- distributes the payout legs (affiliate earning, creator organization credit,
-- creator redeemable earning, usage row, usage stats) fire-and-forget. Before
-- this table nothing tied those legs to the debit: the creator earning was
-- keyed on the constant MCP id with no dedupe, the creator org-credit and the
-- usage row had no idempotency at all, and the affiliate leg deduped only when
-- the caller passed a precharge transaction id. A settlement retry — a Worker
-- that lost its response and redelivered, or any future reconciliation sweep —
-- replayed every leg and minted duplicate value.
--
-- This table is the single authoritative receipt. (payment_type,
-- payment_event_id) is the canonical identity of the economic event: the
-- precharge credit transaction id for 'credits', the provider payment id for
-- 'x402'. The first committed row wins; a later delivery of the same event
-- compares identity and economics, resumes only missing legs, and rejects a
-- same-key-different-economics attempt as a replay mismatch. Each payout leg
-- carries the settlement id in its own idempotency key
-- (`mcp_settlement:<id>:<leg>`), so legs stay independently recoverable.
--
-- The economics columns are the immutable receipt snapshot (canonical USD
-- micro-grid, mirroring the mcp_usage receipt columns); the buyer debit equals
-- base + affiliate fee + platform fee by check constraint. status is
-- 'settling' while legs apply and flips to terminal 'settled' with settled_at
-- in the same transaction that commits the final leg.

CREATE TABLE IF NOT EXISTS mcp_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_credit_transaction_id uuid,
  buyer_organization_id uuid NOT NULL,
  buyer_user_id uuid,
  mcp_id uuid NOT NULL,
  tool_name text NOT NULL,
  payment_type text NOT NULL,
  payment_event_id text NOT NULL,
  affiliate_owner_id uuid,
  affiliate_code_id uuid,
  creator_organization_id uuid NOT NULL,
  creator_user_id uuid,
  base_amount_usd numeric(18, 6) NOT NULL,
  affiliate_fee_usd numeric(18, 6) NOT NULL,
  platform_fee_usd numeric(18, 6) NOT NULL,
  total_amount_usd numeric(18, 6) NOT NULL,
  creator_earnings_usd numeric(18, 6) NOT NULL,
  platform_earnings_usd numeric(18, 6) NOT NULL,
  x402_amount_usd numeric(18, 6) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'settling',
  affiliate_ledger_entry_id uuid,
  creator_credit_transaction_id uuid,
  creator_ledger_entry_id uuid,
  mcp_usage_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT mcp_settlements_payment_event_uidx UNIQUE (payment_type, payment_event_id),
  CONSTRAINT mcp_settlements_buyer_tenant_fk
    FOREIGN KEY (buyer_credit_transaction_id, buyer_organization_id)
    REFERENCES credit_transactions (id, organization_id)
    ON DELETE restrict,
  CONSTRAINT mcp_settlements_mcp_fk
    FOREIGN KEY (mcp_id) REFERENCES user_mcps (id) ON DELETE restrict,
  CONSTRAINT mcp_settlements_creator_org_fk
    FOREIGN KEY (creator_organization_id) REFERENCES organizations (id) ON DELETE restrict,
  CONSTRAINT mcp_settlements_receipt_check CHECK (
    base_amount_usd >= 0
    AND affiliate_fee_usd >= 0
    AND platform_fee_usd >= 0
    AND total_amount_usd = base_amount_usd + affiliate_fee_usd + platform_fee_usd
    AND total_amount_usd::text <> 'NaN'
    AND creator_earnings_usd >= 0
    AND platform_earnings_usd >= 0
    AND creator_earnings_usd::text <> 'NaN'
    AND platform_earnings_usd::text <> 'NaN'
  ),
  CONSTRAINT mcp_settlements_status_check CHECK (status IN ('settling', 'settled')),
  CONSTRAINT mcp_settlements_x402_check CHECK (
    x402_amount_usd >= 0
    AND (payment_type <> 'x402' OR x402_amount_usd > 0)
  ),
  CONSTRAINT mcp_settlements_terminal_shape_check CHECK (
    (status = 'settling' AND settled_at IS NULL)
    OR (status = 'settled' AND settled_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS mcp_settlements_mcp_idx ON mcp_settlements (mcp_id);
CREATE INDEX IF NOT EXISTS mcp_settlements_buyer_org_idx ON mcp_settlements (buyer_organization_id);

-- Rail shape (#22961): the buyer-debit FK slot belongs to the credits rail
-- only. A credits settlement must name its debit transaction; an x402
-- settlement is funded by the provider payment and must never bind a
-- credit-transaction FK (a UUID-shaped provider id is not a transaction).
ALTER TABLE mcp_settlements ADD CONSTRAINT mcp_settlements_rail_shape_check CHECK (
  (payment_type = 'credits' AND buyer_credit_transaction_id IS NOT NULL)
  OR (payment_type <> 'credits' AND buyer_credit_transaction_id IS NULL)
);

-- One usage row per settlement: concurrent duplicate settlements of the same
-- payment event must not each insert their own mcp_usage row. Legacy rows
-- have no settlement and stay NULL; unique indexes treat NULLs as distinct,
-- so legacy rows never conflict.
ALTER TABLE mcp_usage ADD COLUMN IF NOT EXISTS settlement_id uuid
  REFERENCES mcp_settlements (id) ON DELETE restrict;
CREATE UNIQUE INDEX IF NOT EXISTS mcp_usage_settlement_uidx
  ON mcp_usage (settlement_id);

-- Durable-recovery sweep support (#22961 round-4): the every-minute orphan
-- query filters credit_transactions by the mcp_precharge marker + age and
-- joins settlements by (payment_type, payment_event_id); partial expression
-- indexes keep it off a full-ledger scan on a mature database, and the
-- resume scan indexes the settling tail by age.
CREATE INDEX IF NOT EXISTS credit_transactions_mcp_precharge_idx
  ON credit_transactions (created_at)
  WHERE type = 'debit' AND metadata->>'mcp_precharge' = 'v1';
CREATE INDEX IF NOT EXISTS mcp_settlements_resume_due_idx
  ON mcp_settlements (created_at)
  WHERE status = 'settling';
