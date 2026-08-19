-- Durable first-terminal authority for app-inference reservation settlement.
-- Provisional: journal only after queued 0266 and 0267 land.

CREATE TABLE app_reservation_settlements (
  reservation_transaction_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  app_id uuid NOT NULL,
  user_id uuid NOT NULL,
  creator_user_id uuid,
  terminal_source text NOT NULL,
  outcome text NOT NULL,
  reserved_base_cost numeric(16,6) NOT NULL,
  actual_base_cost numeric(16,6) NOT NULL,
  markup_percentage numeric(12,6) NOT NULL,
  reserved_total_cost numeric(16,6) NOT NULL,
  actual_total_cost numeric(16,6) NOT NULL,
  organization_adjustment numeric(16,6) NOT NULL,
  creator_adjustment numeric(16,6) NOT NULL,
  platform_adjustment numeric(16,6) NOT NULL,
  credit_transaction_id uuid,
  redeemable_ledger_entry_id uuid,
  app_earnings_transaction_id uuid,
  settled_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_reservation_settlements_organization_fk
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT app_reservation_settlements_reservation_tenant_fk
    FOREIGN KEY (reservation_transaction_id, organization_id)
    REFERENCES credit_transactions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT app_reservation_settlements_adjustment_tenant_fk
    FOREIGN KEY (credit_transaction_id, organization_id)
    REFERENCES credit_transactions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT app_reservation_settlements_source_check
    CHECK (terminal_source IN ('provider','stale_sweep')),
  CONSTRAINT app_reservation_settlements_outcome_check
    CHECK (outcome IN ('refund','overage','uncollected_overage','none')),
  CONSTRAINT app_reservation_settlements_economics_check
    CHECK (reserved_base_cost >= 0 AND actual_base_cost >= 0
      AND markup_percentage >= 0 AND reserved_total_cost >= 0 AND actual_total_cost >= 0)
);

CREATE INDEX app_reservation_settlements_org_time_idx
  ON app_reservation_settlements (organization_id, settled_at);

CREATE TABLE app_reservation_settlement_quarantines (
  reservation_transaction_id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  app_id text NOT NULL,
  user_id text NOT NULL,
  creator_user_id text,
  reason text NOT NULL,
  quarantined_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_reservation_settlement_quarantines_organization_fk
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT app_reservation_settlement_quarantines_reservation_tenant_fk
    FOREIGN KEY (reservation_transaction_id, organization_id)
    REFERENCES credit_transactions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT app_reservation_settlement_quarantines_reason_check
    CHECK (reason = 'pre_authority_economics_unreconstructable')
);

CREATE FUNCTION app_reservation_quarantine_uuid(value text) RETURNS text AS $$
  SELECT CASE
    WHEN value ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN lower(value)
    ELSE 'invalid-or-missing'
  END
$$ LANGUAGE sql IMMUTABLE;

CREATE FUNCTION validate_app_reservation_settlement_quarantine() RETURNS trigger AS $$
DECLARE
  reservation_row credit_transactions%ROWTYPE;
  expected_creator text;
BEGIN
  SELECT * INTO reservation_row
  FROM credit_transactions
  WHERE id = NEW.reservation_transaction_id
    AND organization_id = NEW.organization_id
  FOR UPDATE;
  expected_creator := CASE
    WHEN NULLIF(reservation_row.metadata->>'creatorUserId', '') IS NULL THEN NULL
    ELSE app_reservation_quarantine_uuid(reservation_row.metadata->>'creatorUserId')
  END;
  IF NOT FOUND
     OR reservation_row.settled_at IS NULL
     OR reservation_row.type <> 'debit'
     OR reservation_row.metadata->>'type' <> 'app_chat_reservation'
     OR reservation_row.metadata->>'settlement_marker' <> 'app_chat_reservation_v1'
     OR NEW.app_id IS DISTINCT FROM
          app_reservation_quarantine_uuid(reservation_row.metadata->>'appId')
     OR NEW.user_id IS DISTINCT FROM
          app_reservation_quarantine_uuid(reservation_row.metadata->>'userId')
     OR NEW.creator_user_id IS DISTINCT FROM expected_creator
     OR NEW.reason <> 'pre_authority_economics_unreconstructable'
     OR NEW.quarantined_at IS DISTINCT FROM reservation_row.settled_at
     OR EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE reservation_transaction_id = NEW.reservation_transaction_id
     ) THEN
    RAISE EXCEPTION 'app reservation quarantine does not match a legacy terminal hold'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlement_quarantines_authority_match';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER app_reservation_settlement_quarantines_validate_guard
  BEFORE INSERT ON app_reservation_settlement_quarantines
  FOR EACH ROW EXECUTE FUNCTION validate_app_reservation_settlement_quarantine();

CREATE FUNCTION guard_app_reservation_facts() RETURNS trigger AS $$
BEGIN
  IF OLD.type = 'debit'
     AND OLD.metadata->>'type' = 'app_chat_reservation'
     AND OLD.metadata->>'settlement_marker' = 'app_chat_reservation_v1'
     AND (NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.metadata IS DISTINCT FROM OLD.metadata) THEN
    RAISE EXCEPTION 'app reservation identity and economic facts are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'credit_transactions_app_reservation_facts_immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER credit_transactions_app_reservation_facts_immutable_guard
  BEFORE UPDATE ON credit_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_app_reservation_facts();

CREATE FUNCTION validate_app_reservation_settlement_receipt() RETURNS trigger AS $$
DECLARE
  reservation_row credit_transactions%ROWTYPE;
  adjustment_row credit_transactions%ROWTYPE;
  creator_ledger_amount numeric;
  creator_ledger_user uuid;
  creator_ledger_source text;
  app_projection_app uuid;
  app_projection_user uuid;
  app_projection_amount numeric;
  app_projection_ledger text;
BEGIN
  SELECT * INTO reservation_row
  FROM credit_transactions
  WHERE id = NEW.reservation_transaction_id
    AND organization_id = NEW.organization_id
  FOR UPDATE;
  IF NOT FOUND
     OR reservation_row.type <> 'debit'
     OR reservation_row.metadata->>'type' <> 'app_chat_reservation'
     OR reservation_row.metadata->>'settlement_marker' <> 'app_chat_reservation_v1'
     OR lower(reservation_row.metadata->>'appId') IS DISTINCT FROM NEW.app_id::text
     OR lower(reservation_row.metadata->>'userId') IS DISTINCT FROM NEW.user_id::text
     OR lower(NULLIF(reservation_row.metadata->>'creatorUserId', ''))::uuid
          IS DISTINCT FROM NEW.creator_user_id
     OR abs(reservation_row.amount) IS DISTINCT FROM NEW.reserved_total_cost
     OR COALESCE(reservation_row.metadata->>'reserved_amount',
                 reservation_row.metadata->>'baseCost')::numeric
          IS DISTINCT FROM NEW.reserved_base_cost
     OR EXISTS (
       SELECT 1 FROM app_reservation_settlement_quarantines
       WHERE reservation_transaction_id = NEW.reservation_transaction_id
     ) THEN
    RAISE EXCEPTION 'app reservation receipt does not match immutable reservation facts'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_reservation_match';
  END IF;

  IF round(NEW.reserved_base_cost * (1 + NEW.markup_percentage / 100), 6)
       IS DISTINCT FROM NEW.reserved_total_cost
     OR round(NEW.actual_base_cost * (1 + NEW.markup_percentage / 100), 6)
       IS DISTINCT FROM NEW.actual_total_cost
     OR NEW.actual_total_cost - NEW.reserved_total_cost
       IS DISTINCT FROM NEW.organization_adjustment
     OR round((NEW.actual_base_cost - NEW.reserved_base_cost)
       * NEW.markup_percentage / 100, 6) IS DISTINCT FROM NEW.creator_adjustment
     OR NEW.actual_base_cost - NEW.reserved_base_cost
       IS DISTINCT FROM NEW.platform_adjustment THEN
    RAISE EXCEPTION 'app reservation receipt economics are inconsistent'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_economic_match';
  END IF;

  IF NEW.credit_transaction_id IS NOT NULL THEN
    SELECT * INTO adjustment_row
    FROM credit_transactions
    WHERE id = NEW.credit_transaction_id
      AND organization_id = NEW.organization_id;
  END IF;
  IF (NEW.outcome = 'refund' AND (
        NEW.credit_transaction_id IS NULL OR adjustment_row.type <> 'refund'
        OR adjustment_row.amount IS DISTINCT FROM -NEW.organization_adjustment
        OR adjustment_row.stripe_payment_intent_id
          IS DISTINCT FROM 'reconcile-refund:' || NEW.reservation_transaction_id::text
      ))
     OR (NEW.outcome = 'overage' AND (
        NEW.credit_transaction_id IS NULL OR adjustment_row.type <> 'debit'
        OR adjustment_row.amount IS DISTINCT FROM -NEW.organization_adjustment
        OR adjustment_row.stripe_payment_intent_id
          IS DISTINCT FROM 'reconcile-charge:' || NEW.reservation_transaction_id::text
      ))
     OR (NEW.outcome IN ('none', 'uncollected_overage')
       AND NEW.credit_transaction_id IS NOT NULL) THEN
    RAISE EXCEPTION 'app reservation receipt adjustment ledger does not match outcome'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_adjustment_match';
  END IF;

  IF NEW.redeemable_ledger_entry_id IS NOT NULL THEN
    SELECT amount, user_id, earnings_source
      INTO creator_ledger_amount, creator_ledger_user, creator_ledger_source
    FROM redeemable_earnings_ledger
    WHERE id = NEW.redeemable_ledger_entry_id;
  END IF;
  IF NEW.outcome IN ('refund', 'overage') AND trunc(NEW.creator_adjustment, 4) <> 0 THEN
    IF NEW.redeemable_ledger_entry_id IS NULL
       OR creator_ledger_user IS DISTINCT FROM NEW.creator_user_id
       OR creator_ledger_source <> 'miniapp'
       OR creator_ledger_amount IS DISTINCT FROM trunc(NEW.creator_adjustment, 4) THEN
      RAISE EXCEPTION 'app reservation creator ledger does not match receipt'
        USING ERRCODE = '23514',
              CONSTRAINT = 'app_reservation_settlements_creator_match';
    END IF;
  ELSIF NEW.redeemable_ledger_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'app reservation receipt has an unexpected creator ledger'
      USING ERRCODE = '23514',
            CONSTRAINT = 'app_reservation_settlements_creator_match';
  END IF;

  IF NEW.app_earnings_transaction_id IS NOT NULL THEN
    SELECT app_id, user_id, amount, metadata->>'redeemableLedgerEntryId'
      INTO app_projection_app, app_projection_user, app_projection_amount, app_projection_ledger
    FROM app_earnings_transactions
    WHERE id = NEW.app_earnings_transaction_id;
    IF app_projection_app IS DISTINCT FROM NEW.app_id
       OR app_projection_user IS DISTINCT FROM NEW.user_id
       OR app_projection_amount IS DISTINCT FROM trunc(NEW.creator_adjustment, 4)
       OR app_projection_ledger IS DISTINCT FROM NEW.redeemable_ledger_entry_id::text THEN
      RAISE EXCEPTION 'app reservation app projection does not match receipt'
        USING ERRCODE = '23514',
              CONSTRAINT = 'app_reservation_settlements_app_projection_match';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER app_reservation_settlements_validate_guard
  BEFORE INSERT ON app_reservation_settlements
  FOR EACH ROW EXECUTE FUNCTION validate_app_reservation_settlement_receipt();

CREATE FUNCTION guard_app_reservation_settlement_receipt() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'app reservation settlement receipts are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'app_reservation_settlements_immutable';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER app_reservation_settlements_immutable_guard
  BEFORE UPDATE OR DELETE ON app_reservation_settlements
  FOR EACH ROW EXECUTE FUNCTION guard_app_reservation_settlement_receipt();

CREATE TRIGGER app_reservation_settlements_truncate_guard
  BEFORE TRUNCATE ON app_reservation_settlements
  FOR EACH STATEMENT EXECUTE FUNCTION guard_app_reservation_settlement_receipt();

CREATE FUNCTION guard_app_reservation_settlement_quarantine() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'app reservation settlement quarantines are immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'app_reservation_settlement_quarantines_immutable';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER app_reservation_settlement_quarantines_immutable_guard
  BEFORE UPDATE OR DELETE ON app_reservation_settlement_quarantines
  FOR EACH ROW EXECUTE FUNCTION guard_app_reservation_settlement_quarantine();

CREATE TRIGGER app_reservation_settlement_quarantines_truncate_guard
  BEFORE TRUNCATE ON app_reservation_settlement_quarantines
  FOR EACH STATEMENT EXECUTE FUNCTION guard_app_reservation_settlement_quarantine();

CREATE FUNCTION quarantine_legacy_app_reservation_settlement() RETURNS trigger AS $$
BEGIN
  IF OLD.settled_at IS NULL
     AND NEW.settled_at IS NOT NULL
     AND NEW.type = 'debit'
     AND NEW.metadata->>'type' = 'app_chat_reservation'
     AND NEW.metadata->>'settlement_marker' = 'app_chat_reservation_v1'
     AND NOT EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE reservation_transaction_id = NEW.id
     )
     AND NOT EXISTS (
       SELECT 1 FROM app_reservation_settlement_quarantines
       WHERE reservation_transaction_id = NEW.id
     ) THEN
    INSERT INTO app_reservation_settlement_quarantines (
      reservation_transaction_id, organization_id, app_id, user_id,
      creator_user_id, reason, quarantined_at
    ) VALUES (
      NEW.id, NEW.organization_id,
      app_reservation_quarantine_uuid(NEW.metadata->>'appId'),
      app_reservation_quarantine_uuid(NEW.metadata->>'userId'),
      CASE WHEN NULLIF(NEW.metadata->>'creatorUserId', '') IS NULL THEN NULL
        ELSE app_reservation_quarantine_uuid(NEW.metadata->>'creatorUserId') END,
      'pre_authority_economics_unreconstructable', NEW.settled_at
    );
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER credit_transactions_legacy_app_settlement_quarantine_guard
  AFTER UPDATE OF settled_at ON credit_transactions
  FOR EACH ROW EXECUTE FUNCTION quarantine_legacy_app_reservation_settlement();

CREATE FUNCTION guard_app_reservation_credit_projection() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE credit_transaction_id = OLD.id
     )
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.stripe_payment_intent_id IS DISTINCT FROM OLD.stripe_payment_intent_id
       OR NEW.metadata IS DISTINCT FROM OLD.metadata
       OR NEW.settled_at IS DISTINCT FROM OLD.settled_at) THEN
    RAISE EXCEPTION 'referenced app reservation credit projection is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'credit_transactions_app_settlement_projection_immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION guard_app_reservation_creator_projection() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE redeemable_ledger_entry_id = OLD.id
     )
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.earnings_source IS DISTINCT FROM OLD.earnings_source
       OR NEW.source_id IS DISTINCT FROM OLD.source_id
       OR NEW.entry_type IS DISTINCT FROM OLD.entry_type
       OR NEW.metadata IS DISTINCT FROM OLD.metadata) THEN
    RAISE EXCEPTION 'referenced app reservation creator projection is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'redeemable_earnings_app_settlement_projection_immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE FUNCTION guard_app_reservation_app_projection() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE app_earnings_transaction_id = OLD.id
     )
     AND (NEW.id IS DISTINCT FROM OLD.id
       OR NEW.app_id IS DISTINCT FROM OLD.app_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.type IS DISTINCT FROM OLD.type
       OR NEW.metadata IS DISTINCT FROM OLD.metadata) THEN
    RAISE EXCEPTION 'referenced app reservation app projection is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'app_earnings_transactions_app_settlement_projection_immutable';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER credit_transactions_app_settlement_projection_immutable_guard
  BEFORE UPDATE ON credit_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_app_reservation_credit_projection();

CREATE TRIGGER redeemable_earnings_app_settlement_projection_immutable_guard
  BEFORE UPDATE ON redeemable_earnings_ledger
  FOR EACH ROW EXECUTE FUNCTION guard_app_reservation_creator_projection();

CREATE TRIGGER app_earnings_transactions_app_settlement_projection_immutable_guard
  BEFORE UPDATE ON app_earnings_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_app_reservation_app_projection();

CREATE FUNCTION guard_app_reservation_creator_projection_delete() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() <= 1
     AND EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE redeemable_ledger_entry_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'referenced app reservation creator projection cannot be deleted directly'
      USING ERRCODE = '23514', CONSTRAINT = 'redeemable_earnings_app_settlement_projection_delete';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER redeemable_earnings_app_settlement_projection_delete_guard
  BEFORE DELETE ON redeemable_earnings_ledger
  FOR EACH ROW EXECUTE FUNCTION guard_app_reservation_creator_projection_delete();

CREATE FUNCTION guard_app_reservation_app_projection_delete() RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() <= 1
     AND EXISTS (
       SELECT 1 FROM app_reservation_settlements
       WHERE app_earnings_transaction_id = OLD.id
     ) THEN
    RAISE EXCEPTION 'referenced app reservation app projection cannot be deleted directly'
      USING ERRCODE = '23514', CONSTRAINT = 'app_earnings_transactions_app_settlement_projection_delete';
  END IF;
  RETURN OLD;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER app_earnings_transactions_app_settlement_projection_delete_guard
  BEFORE DELETE ON app_earnings_transactions
  FOR EACH ROW EXECUTE FUNCTION guard_app_reservation_app_projection_delete();

CREATE FUNCTION guard_app_reservation_creator_projection_truncate() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_reservation_settlements WHERE redeemable_ledger_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'referenced app reservation creator projections cannot be truncated'
      USING ERRCODE = '23514', CONSTRAINT = 'redeemable_earnings_app_settlement_projection_truncate';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER redeemable_earnings_app_settlement_projection_truncate_guard
  BEFORE TRUNCATE ON redeemable_earnings_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION guard_app_reservation_creator_projection_truncate();

CREATE FUNCTION guard_app_reservation_app_projection_truncate() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app_reservation_settlements WHERE app_earnings_transaction_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'referenced app reservation app projections cannot be truncated'
      USING ERRCODE = '23514', CONSTRAINT = 'app_earnings_transactions_app_settlement_projection_truncate';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER app_earnings_transactions_app_settlement_projection_truncate_guard
  BEFORE TRUNCATE ON app_earnings_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION guard_app_reservation_app_projection_truncate();

-- A historical settlement is exact only when its server-keyed org adjustment
-- contains the complete zero-markup contract. Creator-bearing historical rows
-- are quarantined below because their multi-ledger commit cannot be proven from
-- the pre-authority schema without inventing a projection identity.
WITH historical AS (
  SELECT
    r.*,
    CASE WHEN r.metadata->>'reserved_amount' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (r.metadata->>'reserved_amount')::numeric END AS reserved_base,
    CASE WHEN a.metadata->>'actualBaseCost' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (a.metadata->>'actualBaseCost')::numeric END AS actual_base,
    CASE WHEN a.metadata->>'estimatedBaseCost' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (a.metadata->>'estimatedBaseCost')::numeric END AS adjustment_estimate,
    CASE WHEN a.metadata->>'markupPercentage' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (a.metadata->>'markupPercentage')::numeric END AS adjustment_markup,
    a.id AS adjustment_id,
    a.amount AS adjustment_amount,
    a.type AS adjustment_type,
    a.metadata AS adjustment_metadata
  FROM credit_transactions r
  JOIN credit_transactions a
    ON a.organization_id = r.organization_id
   AND a.stripe_payment_intent_id IN (
     'reconcile-refund:' || r.id::text,
     'reconcile-charge:' || r.id::text
   )
  WHERE r.settled_at IS NOT NULL
    AND r.type = 'debit'
    AND r.metadata->>'type' = 'app_chat_reservation'
    AND r.metadata->>'settlement_marker' = 'app_chat_reservation_v1'
), exact AS (
  SELECT * FROM historical
  WHERE reserved_base IS NOT NULL
    AND actual_base IS NOT NULL
    AND abs(amount) = round(reserved_base, 6)
    AND adjustment_estimate = reserved_base
    AND adjustment_markup = 0
    AND adjustment_metadata->>'reservation_transaction_id' = id::text
    AND ((adjustment_type = 'refund' AND actual_base < reserved_base
          AND adjustment_amount = reserved_base - actual_base)
      OR (adjustment_type = 'debit' AND actual_base > reserved_base
          AND adjustment_amount = -(actual_base - reserved_base)))
)
INSERT INTO app_reservation_settlements (
  reservation_transaction_id, organization_id, app_id, user_id, creator_user_id,
  terminal_source, outcome, reserved_base_cost, actual_base_cost, markup_percentage,
  reserved_total_cost, actual_total_cost, organization_adjustment,
  creator_adjustment, platform_adjustment, credit_transaction_id, settled_at
)
SELECT
  id, organization_id, (metadata->>'appId')::uuid, (metadata->>'userId')::uuid,
  NULLIF(metadata->>'creatorUserId', '')::uuid,
  CASE WHEN adjustment_metadata->>'settlement_source' = 'stale_reservation_sweep'
    THEN 'stale_sweep' ELSE 'provider' END,
  CASE WHEN adjustment_type = 'refund' THEN 'refund' ELSE 'overage' END,
  round(reserved_base, 6), round(actual_base, 6), 0,
  abs(amount), round(actual_base, 6), round(actual_base - reserved_base, 6),
  0, round(actual_base - reserved_base, 6), adjustment_id, settled_at
FROM exact
WHERE metadata->>'appId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND metadata->>'userId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  AND (NULLIF(metadata->>'creatorUserId', '') IS NULL
    OR metadata->>'creatorUserId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$');

INSERT INTO app_reservation_settlement_quarantines (
  reservation_transaction_id, organization_id, app_id, user_id, creator_user_id, reason,
  quarantined_at
)
SELECT
  r.id, r.organization_id,
  app_reservation_quarantine_uuid(r.metadata->>'appId'),
  app_reservation_quarantine_uuid(r.metadata->>'userId'),
  CASE WHEN NULLIF(r.metadata->>'creatorUserId', '') IS NULL THEN NULL
    ELSE app_reservation_quarantine_uuid(r.metadata->>'creatorUserId') END,
  'pre_authority_economics_unreconstructable', r.settled_at
FROM credit_transactions r
LEFT JOIN app_reservation_settlements s ON s.reservation_transaction_id = r.id
WHERE r.settled_at IS NOT NULL
  AND r.type = 'debit'
  AND r.metadata->>'type' = 'app_chat_reservation'
  AND r.metadata->>'settlement_marker' = 'app_chat_reservation_v1'
  AND s.reservation_transaction_id IS NULL;
