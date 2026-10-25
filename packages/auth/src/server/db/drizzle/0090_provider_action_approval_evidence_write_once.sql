-- SEC-031: approval evidence on provider_action_bindings is write-once.
--
-- The binding guard's `mutable` list includes the approval evidence columns
-- (approval_actor_user_id, approval_queue_id, approval_commitment_hash,
-- approved_at) but previously imposed no write-once rule on them (contrast the
-- execution_policy_* gate added in 0084). A same-status UPDATE could therefore
-- rewrite WHO approved an action and WHAT request was approved, post-hoc, and
-- the app-level HMAC audit chain never sees direct DB writes.
--
-- Approval evidence may now only transition NULL -> value, and only during the
-- initial decision transitions out of pending_approval (approved carries the
-- actor + timestamp; approval_denied carries the deciding actor). After the
-- decision lands, the evidence is frozen across every later transition —
-- expire/stale deliberately preserve it (see provider-approval.ts).

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
  approval_evidence_changed boolean;
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

  -- Approval evidence is write-once: each changed column may only transition
  -- NULL -> value, and only during the pending_approval decision transitions
  -- (approved records actor + approved_at; approval_denied records the actor).
  -- Same-status or post-decision rewrites of who/what was approved are rejected.
  approval_evidence_changed :=
    OLD.approval_actor_user_id IS DISTINCT FROM NEW.approval_actor_user_id OR
    OLD.approval_queue_id IS DISTINCT FROM NEW.approval_queue_id OR
    OLD.approval_commitment_hash IS DISTINCT FROM NEW.approval_commitment_hash OR
    OLD.approved_at IS DISTINCT FROM NEW.approved_at;
  IF approval_evidence_changed AND NOT (
    OLD.status = 'pending_approval' AND NEW.status IN ('approved','approval_denied') AND
    (OLD.approval_actor_user_id IS NOT DISTINCT FROM NEW.approval_actor_user_id OR
      (OLD.approval_actor_user_id IS NULL AND NEW.approval_actor_user_id IS NOT NULL)) AND
    (OLD.approval_queue_id IS NOT DISTINCT FROM NEW.approval_queue_id OR
      (OLD.approval_queue_id IS NULL AND NEW.approval_queue_id IS NOT NULL)) AND
    (OLD.approval_commitment_hash IS NOT DISTINCT FROM NEW.approval_commitment_hash OR
      (OLD.approval_commitment_hash IS NULL AND NEW.approval_commitment_hash IS NOT NULL)) AND
    (OLD.approved_at IS NOT DISTINCT FROM NEW.approved_at OR
      (OLD.approved_at IS NULL AND NEW.approved_at IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'illegal provider approval evidence mutation' USING ERRCODE = '23514';
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
