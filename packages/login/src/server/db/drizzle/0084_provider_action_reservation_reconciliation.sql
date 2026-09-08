-- #240: append-only, generation-specific provider policy reservations.
CREATE TABLE "provider_action_reservation_generations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "intent_id" varchar(64) NOT NULL,
  "tenant_id" varchar(64) NOT NULL,
  "generation" integer NOT NULL,
  "phase" varchar(16) NOT NULL,
  "handles" jsonb NOT NULL,
  "state" varchar(24) NOT NULL DEFAULT 'pending',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_retry_at" timestamptz,
  "last_error" text,
  "claimed_at" timestamptz,
  "claimed_by" uuid,
  "reconciled_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "provider_action_reservation_generations_intent_fk"
    FOREIGN KEY ("tenant_id","intent_id") REFERENCES "intents"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "provider_action_reservation_generations_intent_gen_uniq" UNIQUE ("intent_id","generation"),
  CONSTRAINT "provider_action_reservation_generations_shape_chk" CHECK (
    "generation" > 0 AND "phase" IN ('decision','execution')
    AND "state" IN ('pending','needs_attention','settled','released') AND "attempts" >= 0
    AND jsonb_typeof("handles") = 'object'
    AND "handles"->>'schemaVersion' = 'steward.provider-policy-reservations.v1'
    AND ("handles"->>'generation')::integer = "generation" AND "handles"->>'phase' = "phase"
    AND jsonb_typeof("handles"->'cumulativeSpend') = 'array'
    AND (jsonb_array_length("handles"->'cumulativeSpend') > 0 OR
      ("handles" ? 'windowedInvoke' AND "handles"->'windowedInvoke' <> 'null'::jsonb))
    AND (("state" IN ('pending','needs_attention') AND "reconciled_at" IS NULL) OR
      ("state" IN ('settled','released') AND "reconciled_at" IS NOT NULL))
  )
);
--> statement-breakpoint
CREATE INDEX "provider_action_reservation_generations_due_idx"
  ON "provider_action_reservation_generations"
    (COALESCE("next_retry_at", '-infinity'::timestamptz), "created_at", "id")
  WHERE "state" = 'pending' OR ("state" = 'needs_attention' AND "next_retry_at" IS NOT NULL);
--> statement-breakpoint
CREATE INDEX "provider_action_reservation_generations_tenant_due_idx"
  ON "provider_action_reservation_generations"
    ("tenant_id", COALESCE("next_retry_at", '-infinity'::timestamptz), "created_at", "id")
  WHERE "state" = 'pending' OR ("state" = 'needs_attention' AND "next_retry_at" IS NOT NULL);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION steward_provider_reservation_generation_guard()
RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF OLD.intent_id IS DISTINCT FROM NEW.intent_id OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id OR
     OLD.generation IS DISTINCT FROM NEW.generation OR OLD.phase IS DISTINCT FROM NEW.phase OR
     OLD.handles IS DISTINCT FROM NEW.handles OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'provider reservation generation identity mutated' USING ERRCODE='23514';
  END IF;
  IF OLD.state IN ('settled','released') THEN
    RAISE EXCEPTION 'terminal provider reservation generation mutated' USING ERRCODE='23514';
  END IF;
  IF NEW.attempts < OLD.attempts OR NEW.attempts > OLD.attempts + 1 THEN
    RAISE EXCEPTION 'illegal provider reservation attempt transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
CREATE TRIGGER "provider_action_reservation_generation_guard"
BEFORE UPDATE ON "provider_action_reservation_generations"
FOR EACH ROW EXECUTE FUNCTION steward_provider_reservation_generation_guard();
--> statement-breakpoint

-- #239: the current execute-time policy decision is immutable evidence written
-- in the same transaction that consumes approval and mints authorization.
ALTER TABLE "provider_action_bindings"
  ADD COLUMN "execution_policy_decision_id" uuid,
  ADD COLUMN "execution_policy_revision_hash" varchar(71),
  ADD COLUMN "execution_policy_decision" jsonb,
  ADD COLUMN "execution_policy_decision_hash" varchar(71),
  ADD COLUMN "execution_policy_evaluated_at" timestamptz;
--> statement-breakpoint
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_execution_policy_shape_chk" CHECK (
  ("execution_policy_decision_id" IS NULL AND "execution_policy_revision_hash" IS NULL AND
   "execution_policy_decision" IS NULL AND "execution_policy_decision_hash" IS NULL AND
   "execution_policy_evaluated_at" IS NULL) OR
  ("execution_policy_decision_id" IS NOT NULL AND "execution_policy_revision_hash" ~ '^sha256:[0-9a-f]{64}$' AND
   "execution_policy_decision" IS NOT NULL AND "execution_policy_decision_hash" ~ '^sha256:[0-9a-f]{64}$' AND
   "execution_policy_evaluated_at" IS NOT NULL)
);
--> statement-breakpoint

-- Rollout fence for #239. 0084 introduces execute-time policy evidence, so an
-- older API binary must not be allowed to create a fresh execution_ready row
-- without it while a rolling deployment is in progress. NOT VALID deliberately
-- avoids rejecting historical executing/terminal rows whose provider outcome
-- may already be unknown, while PostgreSQL still enforces the check for every
-- new insert/update immediately.
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_execution_policy_ready_chk" CHECK (
  "status" NOT IN ('execution_ready','executing') OR "execution_policy_decision_id" IS NOT NULL
) NOT VALID;
--> statement-breakpoint

-- Existing execution_ready rows were authorized before execute-time cap
-- reservation existed. Never bless them retroactively: revoke an unclaimed v2
-- nonce, terminalize the binding/intent, and enqueue durable recovery evidence.
-- A data-modifying CTE keeps the rollout disposition atomic. Already executing
-- rows are intentionally left alone because an external effect may have begun;
-- the NOT VALID fence above prevents any new evidence-less execution arm.
WITH legacy AS MATERIALIZED (
  SELECT "tenant_id", "intent_id"
  FROM "provider_action_bindings"
  WHERE "status" = 'execution_ready' AND "execution_policy_decision_id" IS NULL
), revoked AS (
  UPDATE "execution_authorization_nonces" n
  SET "status" = 'revoked'
  FROM legacy l
  WHERE n."tenant_id" = l."tenant_id" AND n."intent_id" = l."intent_id"
    AND n."version" = 2 AND n."status" = 'active' AND n."dispatch_state" = 'none'
), transitioned AS (
  UPDATE "provider_action_bindings" b
  SET "status" = 'failed', "binding_revision" = b."binding_revision" + 1, "updated_at" = now()
  FROM legacy l
  WHERE b."tenant_id" = l."tenant_id" AND b."intent_id" = l."intent_id"
    AND b."status" = 'execution_ready' AND b."execution_policy_decision_id" IS NULL
  RETURNING b."tenant_id", b."intent_id"
), failed_intents AS (
  UPDATE "intents" i
  SET "status" = 'failed', "failed_by" = 'steward-system', "failed_at" = now(), "updated_at" = now()
  FROM transitioned t
  WHERE i."tenant_id" = t."tenant_id" AND i."id" = t."intent_id"
)
INSERT INTO "provider_action_audit_outbox"
  ("tenant_id", "intent_id", "action", "resource_type", "resource_id", "metadata")
SELECT t."tenant_id", t."intent_id", 'provider.execution.legacy_policy_evidence_rejected',
       'provider_action', t."intent_id",
       jsonb_build_object(
         'schemaVersion', 'steward.provider-execution-rollout.v1',
         'intentId', t."intent_id",
         'reasonCode', 'EXECUTION_POLICY_EVIDENCE_MISSING'
       )
FROM transitioned t;
--> statement-breakpoint

-- Extend the existing frozen projection narrowly: execution-policy evidence may
-- be populated exactly once, only on approved -> execution_ready. It remains
-- frozen across every later dispatch/outcome transition.
CREATE OR REPLACE FUNCTION steward_provider_action_binding_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  frozen_old jsonb;
  frozen_new jsonb;
  mutable text[] := ARRAY[
    'status','binding_revision','approval_actor_user_id','approval_queue_id',
    'approval_commitment_hash','approved_at','denied_at','expired_at','stale_at',
    'stale_reason_code','resume_actor','resume_attempt_id','resume_validated_at','updated_at',
    'execution_policy_decision_id','execution_policy_revision_hash','execution_policy_decision',
    'execution_policy_decision_hash','execution_policy_evaluated_at'
  ];
  col text;
  execution_policy_changed boolean;
BEGIN
  frozen_old := to_jsonb(OLD);
  frozen_new := to_jsonb(NEW);
  FOREACH col IN ARRAY mutable LOOP
    frozen_old := frozen_old - col;
    frozen_new := frozen_new - col;
  END LOOP;
  IF frozen_old IS DISTINCT FROM frozen_new THEN
    RAISE EXCEPTION 'provider_action_bindings frozen column mutated' USING ERRCODE = '23514';
  END IF;

  execution_policy_changed :=
    OLD.execution_policy_decision_id IS DISTINCT FROM NEW.execution_policy_decision_id OR
    OLD.execution_policy_revision_hash IS DISTINCT FROM NEW.execution_policy_revision_hash OR
    OLD.execution_policy_decision IS DISTINCT FROM NEW.execution_policy_decision OR
    OLD.execution_policy_decision_hash IS DISTINCT FROM NEW.execution_policy_decision_hash OR
    OLD.execution_policy_evaluated_at IS DISTINCT FROM NEW.execution_policy_evaluated_at;
  IF execution_policy_changed AND NOT (
    OLD.status = 'approved' AND NEW.status = 'execution_ready' AND
    OLD.execution_policy_decision_id IS NULL AND
    NEW.execution_policy_decision_id IS NOT NULL AND
    NEW.execution_policy_revision_hash IS NOT NULL AND
    NEW.execution_policy_decision IS NOT NULL AND
    NEW.execution_policy_decision_hash IS NOT NULL AND
    NEW.execution_policy_evaluated_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'illegal provider execution policy mutation' USING ERRCODE = '23514';
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF OLD.status = 'allowed_stub' AND NEW.status IN ('stub_succeeded','stub_failed') THEN
      IF NEW.binding_revision IS DISTINCT FROM OLD.binding_revision THEN
        RAISE EXCEPTION 'provider_action_bindings stub transition must not change binding_revision'
          USING ERRCODE = '23514';
      END IF;
    ELSIF (
      (OLD.status = 'pending_approval' AND NEW.status IN ('approved','approval_denied','approval_expired','approval_stale')) OR
      (OLD.status = 'approved' AND NEW.status IN ('execution_ready','approval_expired','approval_stale')) OR
      (OLD.status = 'execution_ready' AND NEW.status IN ('executing','failed')) OR
      (OLD.status = 'executing' AND NEW.status IN ('succeeded','failed','outcome_unknown')) OR
      (OLD.status = 'outcome_unknown' AND NEW.status IN ('succeeded','failed'))
    ) THEN
      IF NEW.binding_revision IS DISTINCT FROM OLD.binding_revision + 1 THEN
        RAISE EXCEPTION 'provider_action_bindings binding_revision must increment by exactly one on transition'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      RAISE EXCEPTION 'illegal provider_action_bindings status transition' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.binding_revision IS DISTINCT FROM OLD.binding_revision THEN
    RAISE EXCEPTION 'provider_action_bindings binding_revision changed without a status transition'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $fn$;
--> statement-breakpoint
