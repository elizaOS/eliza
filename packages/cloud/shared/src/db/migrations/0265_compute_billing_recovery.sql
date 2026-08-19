-- Compute billing recovery after the canonical billing authority cutover.

-- Establish a cutover cursor for historical rows before new elapsed charging
-- deploys. New rows start their cursor at creation via the defaults below.
UPDATE agent_sandboxes SET last_billed_at = now() WHERE last_billed_at IS NULL;
UPDATE containers SET last_billed_at = now() WHERE last_billed_at IS NULL;

ALTER TABLE agent_sandboxes ALTER COLUMN last_billed_at SET DEFAULT now();
ALTER TABLE containers ALTER COLUMN last_billed_at SET DEFAULT now();

ALTER TABLE agent_sandboxes
  ALTER COLUMN total_billed TYPE numeric(18,6);

ALTER TABLE containers
  ALTER COLUMN total_billed TYPE numeric(18,6);

ALTER TABLE container_billing_records
  ALTER COLUMN amount TYPE numeric(16,6),
  ADD COLUMN rate_segments jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE credit_transactions
  ALTER COLUMN amount TYPE numeric(16,6);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM container_billing_records receipt
    JOIN containers container ON container.id = receipt.container_id
    WHERE container.organization_id <> receipt.organization_id
  ) THEN
    RAISE EXCEPTION 'container billing receipt tenant mismatch; repair before 0265';
  END IF;
END $$;

CREATE UNIQUE INDEX containers_id_organization_unique
  ON containers (id, organization_id);

ALTER TABLE credit_transactions
  ADD CONSTRAINT credit_transactions_id_organization_unique
  UNIQUE (id, organization_id);

ALTER TABLE container_billing_records
  DROP CONSTRAINT IF EXISTS container_billing_records_container_id_containers_id_fk,
  DROP CONSTRAINT IF EXISTS container_billing_records_container_tenant_fk,
  DROP CONSTRAINT IF EXISTS container_billing_records_credit_transaction_id_credit_transactions_id_fk,
  DROP CONSTRAINT IF EXISTS container_billing_records_organization_id_organizations_id_fk;

-- Historical container receipts predate durable ledger binding. Preserve the
-- receipt verbatim and record every absent or cross-tenant transaction for
-- explicit reconciliation instead of inventing or deleting ledger history.
CREATE TABLE container_billing_legacy_ledger_bindings (
  receipt_id uuid PRIMARY KEY
    REFERENCES container_billing_records(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL
    REFERENCES organizations(id) ON DELETE RESTRICT,
  credit_transaction_id uuid,
  classification text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT container_billing_legacy_ledger_bindings_classification_check
    CHECK (classification IN ('missing_reference', 'missing_transaction', 'tenant_mismatch'))
);

CREATE OR REPLACE FUNCTION guard_container_billing_legacy_ledger_binding() RETURNS trigger AS $$
DECLARE
  receipt_organization_id uuid;
  receipt_credit_transaction_id uuid;
  receipt_status text;
  transaction_organization_id uuid;
  expected_classification text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'legacy compute ledger binding audit is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'container_billing_legacy_ledger_bindings_immutable';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'legacy compute ledger binding authority is immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'container_billing_legacy_ledger_bindings_immutable';
  END IF;

  SELECT receipt.organization_id, receipt.credit_transaction_id, receipt.status
    INTO receipt_organization_id, receipt_credit_transaction_id, receipt_status
  FROM container_billing_records receipt
  WHERE receipt.id = NEW.receipt_id;
  IF NOT FOUND
     OR receipt_organization_id IS DISTINCT FROM NEW.organization_id
     OR receipt_credit_transaction_id IS DISTINCT FROM NEW.credit_transaction_id THEN
    RAISE EXCEPTION 'legacy compute ledger binding does not match its receipt'
      USING ERRCODE = '23503',
            CONSTRAINT = 'container_billing_legacy_ledger_bindings_receipt_match';
  END IF;

  IF NEW.credit_transaction_id IS NULL AND receipt_status = 'success' THEN
    expected_classification := 'missing_reference';
  ELSIF NEW.credit_transaction_id IS NULL THEN
    RAISE EXCEPTION 'non-success receipt without a transaction cannot be quarantined'
      USING ERRCODE = '23514',
            CONSTRAINT = 'container_billing_legacy_ledger_bindings_reason';
  ELSE
    SELECT transaction.organization_id
      INTO transaction_organization_id
    FROM credit_transactions transaction
    WHERE transaction.id = NEW.credit_transaction_id;
  END IF;
  IF NEW.credit_transaction_id IS NOT NULL AND NOT FOUND THEN
    expected_classification := 'missing_transaction';
  ELSIF NEW.credit_transaction_id IS NOT NULL
        AND transaction_organization_id IS DISTINCT FROM NEW.organization_id THEN
    expected_classification := 'tenant_mismatch';
  ELSIF NEW.credit_transaction_id IS NOT NULL THEN
    RAISE EXCEPTION 'valid compute ledger binding cannot be quarantined'
      USING ERRCODE = '23514',
            CONSTRAINT = 'container_billing_legacy_ledger_bindings_reason';
  END IF;

  IF NEW.classification IS DISTINCT FROM expected_classification THEN
    RAISE EXCEPTION 'legacy compute ledger binding classification is incorrect'
      USING ERRCODE = '23514',
            CONSTRAINT = 'container_billing_legacy_ledger_bindings_reason';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER container_billing_legacy_ledger_bindings_guard
  BEFORE INSERT OR UPDATE OR DELETE ON container_billing_legacy_ledger_bindings
  FOR EACH ROW EXECUTE FUNCTION guard_container_billing_legacy_ledger_binding();

CREATE OR REPLACE FUNCTION reject_container_billing_legacy_ledger_bindings_truncate()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'legacy compute ledger binding audit is immutable'
    USING ERRCODE = '23514',
          CONSTRAINT = 'container_billing_legacy_ledger_bindings_immutable';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER container_billing_legacy_ledger_bindings_truncate_guard
  BEFORE TRUNCATE ON container_billing_legacy_ledger_bindings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_container_billing_legacy_ledger_bindings_truncate();

CREATE INDEX container_billing_legacy_ledger_bindings_org_created_idx
  ON container_billing_legacy_ledger_bindings (organization_id, created_at);

INSERT INTO container_billing_legacy_ledger_bindings (
  receipt_id,
  organization_id,
  credit_transaction_id,
  classification
)
SELECT receipt.id,
       receipt.organization_id,
       receipt.credit_transaction_id,
       CASE
         WHEN receipt.credit_transaction_id IS NULL THEN 'missing_reference'
         WHEN transaction.id IS NULL THEN 'missing_transaction'
         ELSE 'tenant_mismatch'
       END
FROM container_billing_records receipt
LEFT JOIN credit_transactions transaction
  ON transaction.id = receipt.credit_transaction_id
WHERE (receipt.status = 'success' AND receipt.credit_transaction_id IS NULL)
   OR (receipt.credit_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM credit_transactions exact_transaction
    WHERE exact_transaction.id = receipt.credit_transaction_id
      AND exact_transaction.organization_id = receipt.organization_id
  ));

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM container_billing_records receipt
    WHERE ((
        receipt.status = 'success'
        AND receipt.credit_transaction_id IS NULL
      ) OR (
        receipt.credit_transaction_id IS NOT NULL
        AND NOT EXISTS (
        SELECT 1
        FROM credit_transactions transaction
        WHERE transaction.id = receipt.credit_transaction_id
          AND transaction.organization_id = receipt.organization_id
      )
      ))
      AND NOT EXISTS (
        SELECT 1
        FROM container_billing_legacy_ledger_bindings legacy
        WHERE legacy.receipt_id = receipt.id
          AND legacy.organization_id = receipt.organization_id
          AND legacy.credit_transaction_id IS NOT DISTINCT FROM receipt.credit_transaction_id
      )
  ) THEN
    RAISE EXCEPTION 'legacy container billing receipt was not quarantined';
  END IF;
END $$;

ALTER TABLE container_billing_records
  ADD CONSTRAINT container_billing_records_organization_id_organizations_id_fk
  FOREIGN KEY (organization_id)
  REFERENCES organizations(id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT container_billing_records_credit_transaction_tenant_fk
  FOREIGN KEY (credit_transaction_id, organization_id)
  REFERENCES credit_transactions(id, organization_id) ON DELETE RESTRICT NOT VALID,
  ADD CONSTRAINT container_billing_records_success_ledger_check
  CHECK (status <> 'success' OR credit_transaction_id IS NOT NULL) NOT VALID;

ALTER TABLE container_billing_records
  VALIDATE CONSTRAINT container_billing_records_organization_id_organizations_id_fk;

CREATE TABLE agent_billing_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  sandbox_id uuid NOT NULL,
  sandbox_status text NOT NULL,
  billing_period_start timestamptz NOT NULL,
  billing_period_end timestamptz NOT NULL,
  hourly_rate numeric(16,6) NOT NULL,
  amount numeric(16,6) NOT NULL,
  rate_segments jsonb NOT NULL DEFAULT '[]'::jsonb,
  credit_transaction_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_billing_records_organization_id_organizations_id_fk
    FOREIGN KEY (organization_id)
    REFERENCES organizations(id) ON DELETE RESTRICT,
  CONSTRAINT agent_billing_records_credit_transaction_tenant_fk
    FOREIGN KEY (credit_transaction_id, organization_id)
    REFERENCES credit_transactions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT agent_billing_records_positive_period_check
    CHECK (billing_period_end > billing_period_start),
  CONSTRAINT agent_billing_records_nonnegative_amount_check
    CHECK (amount >= 0 AND hourly_rate >= 0)
);

CREATE UNIQUE INDEX agent_billing_records_tenant_period_unique
  ON agent_billing_records (organization_id, sandbox_id, billing_period_start);

CREATE INDEX agent_billing_records_sandbox_period_end_idx
  ON agent_billing_records (sandbox_id, billing_period_end);

CREATE OR REPLACE FUNCTION guard_compute_billing_receipt_tenant() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'agent_billing_records' THEN
    IF NOT EXISTS (
      SELECT 1 FROM agent_sandboxes
      WHERE id = NEW.sandbox_id AND organization_id = NEW.organization_id
    ) THEN
      RAISE EXCEPTION 'agent billing receipt workload tenant mismatch'
        USING ERRCODE = '23503', CONSTRAINT = 'agent_billing_records_workload_tenant_guard';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1 FROM containers
    WHERE id = NEW.container_id AND organization_id = NEW.organization_id
  ) THEN
    RAISE EXCEPTION 'container billing receipt workload tenant mismatch'
      USING ERRCODE = '23503', CONSTRAINT = 'container_billing_records_workload_tenant_guard';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_billing_records_workload_tenant_guard
  BEFORE INSERT ON agent_billing_records FOR EACH ROW
  EXECUTE FUNCTION guard_compute_billing_receipt_tenant();

CREATE TRIGGER container_billing_records_workload_tenant_guard
  BEFORE INSERT ON container_billing_records FOR EACH ROW
  EXECUTE FUNCTION guard_compute_billing_receipt_tenant();

CREATE OR REPLACE FUNCTION guard_compute_billing_receipt_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'compute billing receipts are immutable audit history'
    USING ERRCODE = '23514', CONSTRAINT = 'compute_billing_receipt_immutable';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER agent_billing_records_immutable
  BEFORE UPDATE OR DELETE ON agent_billing_records FOR EACH ROW
  EXECUTE FUNCTION guard_compute_billing_receipt_immutable();

CREATE TRIGGER container_billing_records_immutable
  BEFORE UPDATE OR DELETE ON container_billing_records FOR EACH ROW
  EXECUTE FUNCTION guard_compute_billing_receipt_immutable();

CREATE TRIGGER agent_billing_records_truncate_guard
  BEFORE TRUNCATE ON agent_billing_records FOR EACH STATEMENT
  EXECUTE FUNCTION guard_compute_billing_receipt_immutable();

CREATE TRIGGER container_billing_records_truncate_guard
  BEFORE TRUNCATE ON container_billing_records FOR EACH STATEMENT
  EXECUTE FUNCTION guard_compute_billing_receipt_immutable();

ALTER TABLE containers
  ADD COLUMN lifecycle_revision bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION advance_container_lifecycle_revision() RETURNS trigger AS $$
BEGIN
  IF ROW(NEW.status, NEW.image_tag, NEW.environment_vars, NEW.desired_count, NEW.cpu,
         NEW.memory, NEW.node_id, NEW.volume_path)
     IS DISTINCT FROM
     ROW(OLD.status, OLD.image_tag, OLD.environment_vars, OLD.desired_count, OLD.cpu,
         OLD.memory, OLD.node_id, OLD.volume_path) THEN
    NEW.lifecycle_revision := OLD.lifecycle_revision + 1;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER containers_lifecycle_revision_advance
  BEFORE UPDATE ON containers FOR EACH ROW
  EXECUTE FUNCTION advance_container_lifecycle_revision();

CREATE TABLE container_compute_stop_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  container_id uuid NOT NULL,
  lifecycle_revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_started_at timestamptz,
  provider_confirmed_at timestamptz,
  provider_node_id text,
  slot_released_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT container_compute_stop_intents_status_check CHECK (
    status IN ('pending', 'dispatching', 'retry', 'terminal_attention', 'provider_confirmed', 'superseded')
  ),
  CONSTRAINT container_compute_stop_intents_attempts_check CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX container_compute_stop_intents_active_unique
  ON container_compute_stop_intents (organization_id, container_id)
  WHERE status IN ('pending', 'dispatching', 'retry', 'terminal_attention');

CREATE INDEX container_compute_stop_intents_recovery_idx
  ON container_compute_stop_intents (status, next_attempt_at)
  WHERE status IN ('pending', 'retry', 'terminal_attention');

CREATE TABLE agent_compute_stop_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  agent_id uuid NOT NULL,
  lifecycle_revision bigint NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  job_id uuid REFERENCES jobs(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_started_at timestamptz,
  provider_confirmed_at timestamptz,
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_compute_stop_intents_status_check CHECK (
    status IN ('pending', 'dispatching', 'retry', 'terminal_attention', 'provider_confirmed', 'superseded')
  ),
  CONSTRAINT agent_compute_stop_intents_attempts_check CHECK (attempts >= 0)
);

CREATE UNIQUE INDEX agent_compute_stop_intents_active_unique
  ON agent_compute_stop_intents (organization_id, agent_id)
  WHERE status IN ('pending', 'dispatching', 'retry', 'terminal_attention');

CREATE INDEX agent_compute_stop_intents_recovery_idx
  ON agent_compute_stop_intents (status, next_attempt_at)
  WHERE status IN ('pending', 'retry', 'terminal_attention');

INSERT INTO agent_compute_stop_intents (
  organization_id, agent_id, lifecycle_revision, status, job_id, next_attempt_at
)
SELECT sandbox.organization_id,
       sandbox.id,
       sandbox.lifecycle_revision,
       'pending',
       active_job.id,
       now()
FROM agent_sandboxes sandbox
LEFT JOIN LATERAL (
  SELECT job.id
  FROM jobs job
  WHERE job.organization_id = sandbox.organization_id
    AND job.agent_id = sandbox.id::text
    AND job.type = 'agent_suspend'
    AND job.status IN ('pending', 'in_progress')
  ORDER BY job.created_at DESC, job.id DESC
  LIMIT 1
) active_job ON true
WHERE sandbox.status = 'running'
  AND sandbox.billing_status = 'shutdown_pending';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM agent_compute_stop_intents intent
    JOIN jobs job ON job.id = intent.job_id
    WHERE job.data_storage <> 'inline'
       OR jsonb_typeof(job.data) <> 'object'
  ) THEN
    RAISE EXCEPTION 'legacy billing suspend job data is not safely upgradable';
  END IF;
END $$;

UPDATE jobs job
SET data = jsonb_set(job.data, '{authorization}', to_jsonb('billing_request'::text), true),
    updated_at = now()
FROM agent_compute_stop_intents intent
WHERE intent.job_id = job.id
  AND NOT (job.data ? 'authorization');

CREATE TABLE compute_billing_rate_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  workload_kind text NOT NULL,
  workload_id uuid NOT NULL,
  lifecycle_revision bigint NOT NULL,
  billing_state text NOT NULL,
  rate_per_hour numeric(16,6) NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT compute_billing_rate_segments_kind_check
    CHECK (workload_kind IN ('agent', 'container')),
  CONSTRAINT compute_billing_rate_segments_rate_check
    CHECK (rate_per_hour >= 0)
);

CREATE INDEX compute_billing_rate_segments_workload_time_idx
  ON compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, effective_at, id);

CREATE OR REPLACE FUNCTION append_agent_compute_billing_rate_segment() RETURNS trigger AS $$
DECLARE next_state text;
DECLARE next_rate numeric(16,6);
BEGIN
  next_state := CASE
    WHEN NEW.execution_tier = 'shared' THEN 'exempt'
    WHEN NEW.status = 'running' THEN 'running'
    WHEN NEW.status = 'stopped' AND NEW.last_backup_at IS NOT NULL THEN 'backup'
    ELSE 'not_billable'
  END;
  next_rate := CASE next_state WHEN 'running' THEN 0.010000
    WHEN 'backup' THEN 0.002500 ELSE 0.000000 END;
  IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.execution_tier, NEW.last_backup_at)
      IS DISTINCT FROM ROW(OLD.status, OLD.execution_tier, OLD.last_backup_at) THEN
    INSERT INTO compute_billing_rate_segments
      (organization_id, workload_kind, workload_id, lifecycle_revision,
       billing_state, rate_per_hour, effective_at)
    VALUES (NEW.organization_id, 'agent', NEW.id, NEW.lifecycle_revision,
      next_state, next_rate, clock_timestamp());
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION append_container_compute_billing_rate_segment() RETURNS trigger AS $$
DECLARE next_state text;
DECLARE next_daily_rate numeric(16,6);
BEGIN
  next_state := CASE WHEN NEW.status = 'running' THEN 'running' ELSE 'not_billable' END;
  next_daily_rate := CASE WHEN next_state = 'running' THEN ROUND((
    0.67::numeric * GREATEST(NEW.desired_count, 1)
    * CASE WHEN NEW.cpu > 1024 THEN NEW.cpu::numeric / 1024 ELSE 1 END
    * CASE WHEN NEW.memory > 2048 THEN sqrt(NEW.memory::numeric / 2048) ELSE 1 END
  ), 2) ELSE 0 END;
  IF TG_OP = 'INSERT' OR ROW(NEW.status, NEW.desired_count, NEW.cpu, NEW.memory)
      IS DISTINCT FROM ROW(OLD.status, OLD.desired_count, OLD.cpu, OLD.memory) THEN
    INSERT INTO compute_billing_rate_segments
      (organization_id, workload_kind, workload_id, lifecycle_revision,
       billing_state, rate_per_hour, effective_at)
    VALUES (NEW.organization_id, 'container', NEW.id, NEW.lifecycle_revision,
      next_state, next_daily_rate / 24, clock_timestamp());
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at)
SELECT organization_id, 'agent', id, lifecycle_revision,
  CASE WHEN execution_tier = 'shared' THEN 'exempt'
    WHEN status = 'running' THEN 'running'
    WHEN status = 'stopped' AND last_backup_at IS NOT NULL THEN 'backup'
    ELSE 'not_billable' END,
  CASE WHEN execution_tier = 'shared' THEN 0
    WHEN status = 'running' THEN 0.010000
    WHEN status = 'stopped' AND last_backup_at IS NOT NULL THEN 0.002500
    ELSE 0 END,
  last_billed_at
FROM agent_sandboxes;

INSERT INTO compute_billing_rate_segments
  (organization_id, workload_kind, workload_id, lifecycle_revision,
   billing_state, rate_per_hour, effective_at)
SELECT organization_id, 'container', id, lifecycle_revision,
  CASE WHEN status = 'running' THEN 'running' ELSE 'not_billable' END,
  CASE WHEN status = 'running' THEN ROUND((
    0.67::numeric * GREATEST(desired_count, 1)
    * CASE WHEN cpu > 1024 THEN cpu::numeric / 1024 ELSE 1 END
    * CASE WHEN memory > 2048 THEN sqrt(memory::numeric / 2048) ELSE 1 END
  ), 2) / 24 ELSE 0 END,
  last_billed_at
FROM containers;

CREATE TRIGGER agent_compute_billing_rate_segment_append
  AFTER INSERT OR UPDATE OF status, execution_tier, last_backup_at
  ON agent_sandboxes FOR EACH ROW
  EXECUTE FUNCTION append_agent_compute_billing_rate_segment();

CREATE TRIGGER container_compute_billing_rate_segment_append
  AFTER INSERT OR UPDATE OF status, desired_count, cpu, memory
  ON containers FOR EACH ROW
  EXECUTE FUNCTION append_container_compute_billing_rate_segment();

CREATE TRIGGER compute_billing_rate_segments_immutable
  BEFORE UPDATE OR DELETE ON compute_billing_rate_segments FOR EACH ROW
  EXECUTE FUNCTION guard_compute_billing_receipt_immutable();

CREATE TRIGGER compute_billing_rate_segments_truncate_guard
  BEFORE TRUNCATE ON compute_billing_rate_segments FOR EACH STATEMENT
  EXECUTE FUNCTION guard_compute_billing_receipt_immutable();
