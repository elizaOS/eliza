-- Fails closed on partial knowledge: no trigger without cross-class agreement,
-- no step without its predecessor, and no settlement by a lease that no longer
-- holds the operation.

CREATE OR REPLACE FUNCTION "guard_agent_node_failure_event_write"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind_count integer; class_count integer; observation_count integer;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW."node_record_id", NEW."node_id", NEW."node_incarnation", NEW."node_history_id",
           NEW."corroboration_required", NEW."first_observed_at", NEW."created_at")
       IS DISTINCT FROM
       ROW(OLD."node_record_id", OLD."node_id", OLD."node_incarnation", OLD."node_history_id",
           OLD."corroboration_required", OLD."first_observed_at", OLD."created_at") THEN
      RAISE EXCEPTION 'node failure record identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" IN ('cleared', 'inconclusive') AND NEW."status" IS DISTINCT FROM OLD."status" THEN
      RAISE EXCEPTION 'a closed node failure record is immutable' USING ERRCODE = '55000';
    END IF;
    IF OLD."status" = 'triggered' AND NEW."status" NOT IN ('triggered', 'cleared') THEN
      RAISE EXCEPTION 'invalid node failure record transition: % -> %', OLD."status", NEW."status" USING ERRCODE = '55000';
    END IF;
    IF OLD."enumerated_at" IS NOT NULL AND NEW."enumerated_at" IS DISTINCT FROM OLD."enumerated_at" THEN
      RAISE EXCEPTION 'the frozen agent set is immutable once recorded' USING ERRCODE = '55000';
    END IF;
    IF OLD."cordoned_at" IS NOT NULL AND NEW."cordoned_at" IS DISTINCT FROM OLD."cordoned_at" THEN
      RAISE EXCEPTION 'the cordon instant is immutable once recorded' USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW."status" = 'triggered' THEN
    SELECT count(DISTINCT signal."kind"), count(DISTINCT signal."source_class"),
           COALESCE(sum(signal."observation_count"), 0)
      INTO kind_count, class_count, observation_count
      FROM "agent_node_failure_signals" signal
      WHERE signal."failure_event_id" = NEW."id";
    IF kind_count < 2 THEN
      RAISE EXCEPTION 'a node failure trigger requires two distinct observation kinds' USING ERRCODE = '55000';
    END IF;
    IF class_count < 2 THEN
      RAISE EXCEPTION 'a node failure trigger requires two distinct independence classes' USING ERRCODE = '55000';
    END IF;
    IF observation_count < NEW."corroboration_required" THEN
      RAISE EXCEPTION 'a node failure trigger requires % corroborating observations', NEW."corroboration_required" USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW."enumerated_at" IS NOT NULL THEN
    IF NEW."status" NOT IN ('triggered', 'cleared') THEN
      RAISE EXCEPTION 'only a triggered node failure can freeze its agent set' USING ERRCODE = '55000';
    END IF;
    IF NEW."cordoned_at" IS NULL THEN
      RAISE EXCEPTION 'freezing the agent set requires cordoning the node in the same record' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_node_failure_signal_write"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_status text;
BEGIN
  SELECT event."status" INTO parent_status FROM "agent_node_failure_events" event
    WHERE event."id" = NEW."failure_event_id" FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'node failure signal requires an existing fault record' USING ERRCODE = '55000';
  END IF;
  IF parent_status <> 'collecting' THEN
    RAISE EXCEPTION 'node failure evidence is frozen once the fault record leaves collection' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF ROW(NEW."kind", NEW."source", NEW."source_class", NEW."policy_version",
           NEW."first_observed_at", NEW."created_at")
       IS DISTINCT FROM
       ROW(OLD."kind", OLD."source", OLD."source_class", OLD."policy_version",
           OLD."first_observed_at", OLD."created_at") THEN
      RAISE EXCEPTION 'node failure signal identity is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW."observation_count" < OLD."observation_count" OR NEW."last_observed_at" < OLD."last_observed_at" THEN
      RAISE EXCEPTION 'node failure re-observation cannot move evidence backward' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_node_failure_candidate_write"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "agent_node_failure_events" event
               WHERE event."id" = OLD."failure_event_id") THEN
      RAISE EXCEPTION 'a frozen agent set cannot be erased while its fault record exists' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a frozen agent set is immutable' USING ERRCODE = '55000';
  END IF;

  SELECT event."status", event."enumerated_at", event."node_history_id",
         event."node_incarnation"
    INTO parent FROM "agent_node_failure_events" event
    WHERE event."id" = NEW."failure_event_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'a frozen agent set requires an existing fault record' USING ERRCODE = '55000';
  END IF;
  IF parent."status" <> 'triggered' THEN
    RAISE EXCEPTION 'only a triggered node failure freezes an agent set' USING ERRCODE = '55000';
  END IF;
  IF parent."enumerated_at" IS NOT NULL THEN
    RAISE EXCEPTION 'the agent set is already frozen for this fault record' USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "agent_activation_publications" publication
    WHERE publication."id" = NEW."source_publication_id"
      AND publication."organization_id" = NEW."organization_id"
      AND publication."agent_id" = NEW."agent_id"
      AND publication."activation_generation" = NEW."source_activation_generation"
      AND publication."lifecycle_revision" = NEW."source_lifecycle_revision"
      AND publication."container_id" = NEW."source_container_id"
      AND publication."node_history_id" = parent."node_history_id"
      AND publication."node_incarnation" = parent."node_incarnation"
  ) THEN
    RAISE EXCEPTION 'a frozen agent must be authorized on the failed occurrence by its publication' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assert_failover_restore_admission_authority"(
  operation_id uuid, operation_organization_id uuid, operation_agent_id uuid,
  operation_restore_operation_id uuid, operation_restore_lease_id uuid,
  operation_restore_lease_owner text, operation_restore_lease_generation uuid,
  operation_restore_backup_id uuid, operation_restore_manifest_sha256 text,
  operation_replacement_attempt_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE restore_operation record; lease record;
BEGIN
  IF operation_restore_operation_id IS NULL THEN
    RAISE EXCEPTION 'restore admission requires a referenced restore operation' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO restore_operation FROM "agent_backup_restore_operations" candidate
    WHERE candidate."id" = operation_restore_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the referenced restore operation does not exist' USING ERRCODE = '55000';
  END IF;
  IF restore_operation."organization_id" <> operation_organization_id
     OR restore_operation."agent_id" <> operation_agent_id THEN
    RAISE EXCEPTION 'the referenced restore operation belongs to a different agent' USING ERRCODE = '55000';
  END IF;
  IF restore_operation."lease_id" <> operation_restore_lease_id
     OR restore_operation."lease_owner_id" <> operation_restore_lease_owner
     OR restore_operation."lease_generation" <> operation_restore_lease_generation THEN
    RAISE EXCEPTION 'the referenced restore operation is not held by the recorded lease' USING ERRCODE = '55000';
  END IF;
  IF restore_operation."backup_id" <> operation_restore_backup_id
     OR restore_operation."expected_manifest_sha256" <> operation_restore_manifest_sha256 THEN
    RAISE EXCEPTION 'the referenced restore operation restores a different source' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO lease FROM "agent_backup_restore_leases" candidate
    WHERE candidate."id" = operation_restore_lease_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the referenced restore lease does not exist' USING ERRCODE = '55000';
  END IF;
  IF lease."organization_id" <> operation_organization_id
     OR lease."agent_id" <> operation_agent_id
     OR lease."backup_id" <> operation_restore_backup_id
     OR lease."owner_id" <> operation_restore_lease_owner
     OR lease."generation" <> operation_restore_lease_generation THEN
    RAISE EXCEPTION 'the referenced restore lease does not authorize this recovery' USING ERRCODE = '55000';
  END IF;
  IF lease."released_at" IS NOT NULL THEN
    RAISE EXCEPTION 'the referenced restore lease is already released' USING ERRCODE = '55000';
  END IF;
  IF operation_replacement_attempt_id IS NOT NULL THEN
    PERFORM 1 FROM "agent_sandbox_replacement_attempts" attempt
      WHERE attempt."id" = operation_replacement_attempt_id
        AND attempt."organization_id" = operation_organization_id
        AND attempt."agent_id" = operation_agent_id
        AND attempt."restore_operation_id" = operation_restore_operation_id
        AND attempt."restore_lease_id" = operation_restore_lease_id
        AND attempt."restore_lease_owner_id" = operation_restore_lease_owner
        AND attempt."restore_lease_generation" = operation_restore_lease_generation
        AND attempt."restore_backup_id" = operation_restore_backup_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the referenced replacement attempt belongs to a different recovery' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF lease."expires_at" <= clock_timestamp() THEN
    RAISE EXCEPTION 'the referenced restore lease has already expired' USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assert_failover_cutover_authority"(
  p_operation_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE operation record; publication record;
BEGIN
  SELECT * INTO operation FROM "agent_failover_operations" candidate
    WHERE candidate."id" = p_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cutover requires an existing operation' USING ERRCODE = '55000';
  END IF;
  IF operation."target_publication_id" IS NULL THEN
    RAISE EXCEPTION 'cutover requires an installed target activation publication' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO publication FROM "agent_activation_publications" candidate
    WHERE candidate."id" = operation."target_publication_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cutover target publication is missing' USING ERRCODE = '55000';
  END IF;
  IF publication."organization_id" <> operation."organization_id"
     OR publication."agent_id" <> operation."agent_id" THEN
    RAISE EXCEPTION 'cutover target publication belongs to a different agent' USING ERRCODE = '55000';
  END IF;
  IF publication."purpose" <> 'restore' OR publication."backup_id" IS NULL THEN
    RAISE EXCEPTION 'cutover target publication must be a restore publication bound to a backup' USING ERRCODE = '55000';
  END IF;
  IF publication."previous_activation_generation" IS DISTINCT FROM operation."source_activation_generation" THEN
    RAISE EXCEPTION 'cutover target publication must directly succeed the frozen source generation' USING ERRCODE = '55000';
  END IF;
  IF publication."activation_generation" <> operation."target_activation_generation"
     OR publication."lifecycle_revision" <> operation."target_lifecycle_revision" THEN
    RAISE EXCEPTION 'cutover target publication does not match the recorded target authority' USING ERRCODE = '55000';
  END IF;
  IF publication."lifecycle_revision" <= operation."source_lifecycle_revision" THEN
    RAISE EXCEPTION 'cutover requires a strictly newer activation authority than the source instance' USING ERRCODE = '55000';
  END IF;
  IF publication."container_id" <> operation."target_container_id"
     OR publication."activation_receipt_sha256" <> operation."target_receipt_sha256" THEN
    RAISE EXCEPTION 'cutover target publication does not match the recorded container or receipt' USING ERRCODE = '55000';
  END IF;
  IF publication."docker_node_record_id" <> operation."target_node_record_id"
     OR publication."node_history_id" <> operation."target_node_history_id"
     OR publication."node_incarnation" <> operation."target_node_incarnation" THEN
    RAISE EXCEPTION 'cutover target publication does not match the recorded target node occurrence' USING ERRCODE = '55000';
  END IF;
  IF operation."restore_backup_id" IS DISTINCT FROM publication."backup_id"
     OR operation."restore_manifest_sha256" IS DISTINCT FROM publication."backup_manifest_sha256" THEN
    RAISE EXCEPTION 'cutover target publication does not match the recorded recovery source' USING ERRCODE = '55000';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_failover_operation_write"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE step_order text[] := ARRAY['isolate_source', 'check_preconditions', 'restore', 'verify',
  'cutover', 'fence_source'];
  cutover_committed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- FOR SHARE serializes against a concurrent withdrawal, which takes FOR
    -- UPDATE on the same row before it checks for outstanding work.
    PERFORM 1 FROM "agent_node_failure_events" event
      WHERE event."id" = NEW."failure_event_id" AND event."status" = 'triggered' FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a failover operation requires a triggered fault record' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW."failure_event_id", NEW."organization_id", NEW."agent_id",
         NEW."source_node_record_id", NEW."source_node_id", NEW."source_node_incarnation",
         NEW."source_node_history_id", NEW."source_container_name", NEW."source_publication_id",
         NEW."source_activation_generation", NEW."source_lifecycle_revision",
         NEW."source_container_id", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."failure_event_id", OLD."organization_id", OLD."agent_id",
         OLD."source_node_record_id", OLD."source_node_id", OLD."source_node_incarnation",
         OLD."source_node_history_id", OLD."source_container_name", OLD."source_publication_id",
         OLD."source_activation_generation", OLD."source_lifecycle_revision",
         OLD."source_container_id", OLD."created_at") THEN
    RAISE EXCEPTION 'failover operation identity is immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD."status" NOT IN ('pending', 'running', 'awaiting_capacity', 'awaiting_reconcile',
      'restore_release_required', 'intervention_required')
     AND NEW."status" IS DISTINCT FROM OLD."status" THEN
    RAISE EXCEPTION 'a terminal failover operation is immutable' USING ERRCODE = '55000';
  END IF;

  IF array_position(step_order, NEW."step") < array_position(step_order, OLD."step") THEN
    RAISE EXCEPTION 'failover step cannot move backward: % -> %', OLD."step", NEW."step" USING ERRCODE = '55000';
  END IF;

  IF OLD."source_data_watermark_at" IS NOT NULL AND NEW."source_data_watermark_at" IS NOT NULL
     AND NEW."source_data_watermark_at" < OLD."source_data_watermark_at" THEN
    RAISE EXCEPTION 'the recovery source watermark may only move forward' USING ERRCODE = '55000';
  END IF;

  -- The cutover identity bundle is written once and replayed, never regenerated.
  IF OLD."target_publication_id" IS NOT NULL
     AND ROW(NEW."target_publication_id", NEW."target_activation_generation",
             NEW."target_lifecycle_revision", NEW."target_container_id",
             NEW."target_receipt_sha256", NEW."target_node_record_id",
             NEW."target_node_incarnation", NEW."target_node_history_id")
       IS DISTINCT FROM
       ROW(OLD."target_publication_id", OLD."target_activation_generation",
           OLD."target_lifecycle_revision", OLD."target_container_id",
           OLD."target_receipt_sha256", OLD."target_node_record_id",
           OLD."target_node_incarnation", OLD."target_node_history_id") THEN
    RAISE EXCEPTION 'the cutover identity bundle is immutable once recorded' USING ERRCODE = '55000';
  END IF;
  IF OLD."restore_operation_id" IS NOT NULL
     AND ROW(NEW."restore_operation_id", NEW."restore_lease_id", NEW."restore_lease_generation",
             NEW."restore_lease_owner", NEW."restore_backup_id", NEW."restore_manifest_sha256")
       IS DISTINCT FROM
       ROW(OLD."restore_operation_id", OLD."restore_lease_id", OLD."restore_lease_generation",
           OLD."restore_lease_owner", OLD."restore_backup_id", OLD."restore_manifest_sha256") THEN
    -- A stalled process must be able to take a fresh restore lease, but only
    -- before any cutover intent exists and only once the old attempt is provably
    -- dead: a released or expired lease, never a live one.
    IF NEW."target_publication_id" IS NOT NULL THEN
      RAISE EXCEPTION 'restore authority cannot be rebound after a cutover intent exists' USING ERRCODE = '55000';
    END IF;
    IF OLD."restore_lease_id" IS NULL
       OR NOT EXISTS (SELECT 1 FROM "agent_backup_restore_leases" old_lease
                      WHERE old_lease."id" = OLD."restore_lease_id"
                        AND (old_lease."released_at" IS NOT NULL
                          OR old_lease."expires_at" <= clock_timestamp())) THEN
      RAISE EXCEPTION 'restore authority may be rebound only from a released or expired lease' USING ERRCODE = '55000';
    END IF;
    PERFORM "assert_failover_restore_admission_authority"(
      NEW."id", NEW."organization_id", NEW."agent_id", NEW."restore_operation_id",
      NEW."restore_lease_id", NEW."restore_lease_owner", NEW."restore_lease_generation",
      NEW."restore_backup_id", NEW."restore_manifest_sha256", NEW."replacement_attempt_id");
  END IF;

  IF OLD."restore_operation_id" IS NULL AND NEW."restore_operation_id" IS NOT NULL THEN
    PERFORM "assert_failover_restore_admission_authority"(
      NEW."id", NEW."organization_id", NEW."agent_id", NEW."restore_operation_id",
      NEW."restore_lease_id", NEW."restore_lease_owner", NEW."restore_lease_generation",
      NEW."restore_backup_id", NEW."restore_manifest_sha256", NEW."replacement_attempt_id");
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM "agent_failover_step_attempts" attempt
    WHERE attempt."operation_id" = OLD."id" AND attempt."step" = 'cutover'
      AND (attempt."state" = 'succeeded'
        OR (attempt."state" = 'reconciled' AND attempt."reconcile_action" = 'continued'))
  ) INTO cutover_committed;

  IF cutover_committed AND NEW."status" IN ('cancelled', 'failed', 'blocked_no_backup') THEN
    RAISE EXCEPTION 'a committed cutover cannot be cancelled or failed; fence the source or escalate' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" = 'intervention_required' AND NOT cutover_committed THEN
    RAISE EXCEPTION 'intervention is only reachable after a committed cutover' USING ERRCODE = '55000';
  END IF;
  IF OLD."replacement_attempt_id" IS NOT NULL
     AND NEW."replacement_attempt_id" IS DISTINCT FROM OLD."replacement_attempt_id" THEN
    RAISE EXCEPTION 'the recorded replacement attempt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."replacement_attempt_id" IS NULL AND NEW."replacement_attempt_id" IS NOT NULL THEN
    -- Attaching the attempt is allowed once, under a live lease, and only for an
    -- attempt that belongs to this recovery.
    PERFORM "assert_failover_restore_admission_authority"(
      NEW."id", NEW."organization_id", NEW."agent_id", NEW."restore_operation_id",
      NEW."restore_lease_id", NEW."restore_lease_owner", NEW."restore_lease_generation",
      NEW."restore_backup_id", NEW."restore_manifest_sha256", NEW."replacement_attempt_id");
  END IF;

  IF NEW."status" IN ('failed', 'cancelled', 'blocked_no_backup')
     AND NEW."restore_lease_id" IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM "agent_backup_restore_leases" held
                   WHERE held."id" = NEW."restore_lease_id"
                     AND held."released_at" IS NOT NULL) THEN
      RAISE EXCEPTION 'a failover cannot fail while it still holds an unreleased restore lease' USING ERRCODE = '55000';
    END IF;
    -- A reserved target slot is returned by the restore path's cleanup-finish
    -- CAS, not by releasing the lease. The question is answered from the restore
    -- authority itself: if an attempt exists for this restore operation and
    -- lease, a slot was reserved, and only that attempt's proven cleanup says it
    -- came back. Keying this off the optional column would let an unrecorded
    -- attempt skip the check entirely.
    IF EXISTS (SELECT 1 FROM "agent_sandbox_replacement_attempts" reserved
               WHERE reserved."restore_operation_id" = NEW."restore_operation_id"
                 AND reserved."restore_lease_id" = NEW."restore_lease_id") THEN
      IF NEW."replacement_attempt_id" IS NULL THEN
        RAISE EXCEPTION 'a reserved target exists; record its replacement attempt before failing the failover' USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM "agent_sandbox_replacement_attempts" attempt
                     WHERE attempt."id" = NEW."replacement_attempt_id"
                       AND attempt."cleanup_proven_at" IS NOT NULL
                       AND attempt."cleanup_receipt_digest" IS NOT NULL) THEN
        RAISE EXCEPTION 'a failover cannot fail before its replacement attempt proves cleanup and capacity release' USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  IF NEW."status" = 'completed' THEN
    IF NOT cutover_committed THEN
      RAISE EXCEPTION 'a failover cannot complete without a committed cutover' USING ERRCODE = '55000';
    END IF;
    IF NEW."step" <> 'fence_source' OR NEW."step_state" <> 'succeeded' THEN
      RAISE EXCEPTION 'a failover completes only after the source authority is fenced' USING ERRCODE = '55000';
    END IF;
    IF NEW."target_publication_id" IS NULL THEN
      RAISE EXCEPTION 'a failover cannot complete without an installed target authority' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW."status" = 'awaiting_reconcile' AND NEW."step_state" <> 'awaiting_reconcile' THEN
    RAISE EXCEPTION 'awaiting reconcile requires the step to be awaiting reconcile' USING ERRCODE = '55000';
  END IF;
  IF NEW."status" <> 'awaiting_reconcile' AND OLD."status" = 'awaiting_reconcile'
     AND NEW."step_state" = 'awaiting_reconcile' THEN
    RAISE EXCEPTION 'an operation awaiting reconcile must resolve its step first' USING ERRCODE = '55000';
  END IF;

  IF NEW."lease_generation" IS DISTINCT FROM OLD."lease_generation" THEN
    IF NEW."lease_generation" IS NULL THEN
      IF OLD."lease_owner" IS NULL THEN
        RAISE EXCEPTION 'failover lease release requires a held lease' USING ERRCODE = '55000';
      END IF;
      IF NEW."lease_owner" IS NOT NULL OR NEW."lease_expires_at" IS NOT NULL OR NEW."lease_heartbeat_at" IS NOT NULL THEN
        RAISE EXCEPTION 'failover lease release must clear the whole fence' USING ERRCODE = '55000';
      END IF;
    ELSIF OLD."lease_generation" IS NULL THEN
      IF NEW."lease_owner" IS NULL OR NEW."lease_expires_at" IS NULL OR NEW."lease_heartbeat_at" IS NULL THEN
        RAISE EXCEPTION 'failover claim must install the whole fence' USING ERRCODE = '55000';
      END IF;
      IF NEW."lease_expires_at" <= NEW."lease_heartbeat_at" THEN
        RAISE EXCEPTION 'failover claim must install a horizon after its heartbeat' USING ERRCODE = '55000';
      END IF;
      IF NEW."claim_count" <> OLD."claim_count" + 1 THEN
        RAISE EXCEPTION 'failover claim must increment claim_count once' USING ERRCODE = '55000';
      END IF;
    ELSE
      IF OLD."lease_expires_at" IS NULL OR OLD."lease_expires_at" > clock_timestamp() THEN
        RAISE EXCEPTION 'a live failover lease cannot be superseded' USING ERRCODE = '55000';
      END IF;
      IF NEW."lease_expires_at" <= NEW."lease_heartbeat_at" THEN
        RAISE EXCEPTION 'failover claim must install a horizon after its heartbeat' USING ERRCODE = '55000';
      END IF;
      IF NEW."claim_count" <> OLD."claim_count" + 1 THEN
        RAISE EXCEPTION 'failover claim must increment claim_count once' USING ERRCODE = '55000';
      END IF;
    END IF;
  ELSIF NEW."lease_generation" IS NOT NULL THEN
    IF NEW."lease_owner" IS DISTINCT FROM OLD."lease_owner" THEN
      RAISE EXCEPTION 'a failover lease fence cannot change owner without rotating' USING ERRCODE = '55000';
    END IF;
    IF OLD."lease_expires_at" <= clock_timestamp() AND NEW."lease_expires_at" > clock_timestamp() THEN
      RAISE EXCEPTION 'an expired failover lease cannot be revived by its old generation' USING ERRCODE = '55000';
    END IF;
    IF NEW."claim_count" <> OLD."claim_count" THEN
      RAISE EXCEPTION 'failover claim_count changes only on claim' USING ERRCODE = '55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_failover_step_attempt_write"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE operation record; publication record; previous record; expected_attempt integer;
  committed_predecessors integer; cutover_committed boolean := false;
  step_order text[] := ARRAY['isolate_source', 'check_preconditions', 'restore', 'verify',
    'cutover', 'fence_source'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Cascading from a deleted operation is legitimate teardown; erasing a
    -- journal row out from under a live operation is not.
    IF EXISTS (SELECT 1 FROM "agent_failover_operations" parent
               WHERE parent."id" = OLD."operation_id") THEN
      RAISE EXCEPTION 'a failover step attempt cannot be erased while its operation exists' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."state" <> 'started' THEN
      RAISE EXCEPTION 'a failover step attempt must open as started' USING ERRCODE = '55000';
    END IF;
    SELECT * INTO operation FROM "agent_failover_operations" candidate
      WHERE candidate."id" = NEW."operation_id" FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'failover step attempt requires an existing operation' USING ERRCODE = '55000';
    END IF;
    IF operation."status" NOT IN ('pending', 'running') THEN
      RAISE EXCEPTION 'failover step attempt requires an active operation' USING ERRCODE = '55000';
    END IF;
    IF operation."lease_owner" IS DISTINCT FROM NEW."lease_owner"
       OR operation."lease_generation" IS DISTINCT FROM NEW."lease_generation"
       OR operation."lease_expires_at" IS NULL
       OR operation."lease_expires_at" <= clock_timestamp() THEN
      RAISE EXCEPTION 'a stale failover executor cannot open a step attempt' USING ERRCODE = '55000';
    END IF;
    IF operation."step" <> NEW."step" THEN
      RAISE EXCEPTION 'a failover step attempt must match the operation step' USING ERRCODE = '55000';
    END IF;
    IF operation."step_state" <> 'in_progress' THEN
      RAISE EXCEPTION 'a failover step attempt requires an in-progress step' USING ERRCODE = '55000';
    END IF;
    IF array_position(step_order, NEW."step") > 1 THEN
      SELECT count(DISTINCT attempt."step") INTO committed_predecessors
        FROM "agent_failover_step_attempts" attempt
        WHERE attempt."operation_id" = NEW."operation_id"
          AND array_position(step_order, attempt."step") < array_position(step_order, NEW."step")
          AND (attempt."state" = 'succeeded'
            OR (attempt."state" = 'reconciled' AND attempt."reconcile_action" = 'continued'));
      IF committed_predecessors <> array_position(step_order, NEW."step") - 1 THEN
        RAISE EXCEPTION 'failover step % requires every earlier step to be committed first', NEW."step" USING ERRCODE = '55000';
      END IF;
    END IF;
    SELECT attempt."attempt", attempt."state" INTO previous FROM "agent_failover_step_attempts" attempt
      WHERE attempt."operation_id" = NEW."operation_id" AND attempt."step" = NEW."step"
      ORDER BY attempt."attempt" DESC LIMIT 1;
    IF FOUND THEN
      IF previous."state" NOT IN ('succeeded', 'failed', 'abandoned', 'reconciled') THEN
        RAISE EXCEPTION 'the interrupted attempt must be reconciled before the step runs again' USING ERRCODE = '55000';
      END IF;
      expected_attempt := previous."attempt" + 1;
    ELSE
      expected_attempt := 1;
    END IF;
    IF NEW."attempt" <> expected_attempt THEN
      RAISE EXCEPTION 'failover step attempt must be the next ordinal (expected %)', expected_attempt USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF ROW(NEW."operation_id", NEW."step", NEW."attempt", NEW."lease_owner", NEW."lease_generation",
         NEW."started_at", NEW."created_at")
     IS DISTINCT FROM
     ROW(OLD."operation_id", OLD."step", OLD."attempt", OLD."lease_owner", OLD."lease_generation",
         OLD."started_at", OLD."created_at") THEN
    RAISE EXCEPTION 'failover step attempt identity is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."state" NOT IN ('started', 'awaiting_reconcile') THEN
    RAISE EXCEPTION 'a settled failover step attempt is immutable' USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'awaiting_reconcile' AND NEW."state" <> 'reconciled' THEN
    RAISE EXCEPTION 'an interrupted attempt must be reconciled or left alone' USING ERRCODE = '55000';
  END IF;
  IF OLD."state" = 'started'
     AND NEW."state" NOT IN ('succeeded', 'failed', 'abandoned', 'awaiting_reconcile', 'reconciled') THEN
    RAISE EXCEPTION 'invalid failover step attempt transition: % -> %', OLD."state", NEW."state" USING ERRCODE = '55000';
  END IF;

  SELECT * INTO operation FROM "agent_failover_operations" candidate
    WHERE candidate."id" = NEW."operation_id" FOR UPDATE;
  IF operation."lease_owner" IS NULL OR operation."lease_generation" IS NULL
     OR operation."lease_expires_at" IS NULL OR operation."lease_expires_at" <= clock_timestamp() THEN
    RAISE EXCEPTION 'a stale failover executor cannot settle a step attempt' USING ERRCODE = '55000';
  END IF;
  IF NEW."state" IN ('succeeded', 'failed', 'abandoned') AND operation."lease_generation" <> OLD."lease_generation" THEN
    RAISE EXCEPTION 'a superseded executor cannot settle its attempt' USING ERRCODE = '55000';
  END IF;
  IF NEW."state" IN ('awaiting_reconcile', 'reconciled') THEN
    IF operation."lease_generation" = OLD."lease_generation" THEN
      RAISE EXCEPTION 'reconciliation requires a fresh lease generation' USING ERRCODE = '55000';
    END IF;
    IF operation."step_state" <> 'awaiting_reconcile' THEN
      RAISE EXCEPTION 'reconciliation requires the operation to be awaiting reconcile' USING ERRCODE = '55000';
    END IF;
  END IF;
  IF NEW."state" = 'succeeded' AND NEW."step" = 'restore'
     AND operation."source_data_watermark_at" IS NULL THEN
    RAISE EXCEPTION 'a restore cannot succeed without naming the data watermark it restored to' USING ERRCODE = '55000';
  END IF;

  IF NEW."step" = 'cutover'
     AND (NEW."state" = 'succeeded'
       OR (NEW."state" = 'reconciled' AND NEW."reconcile_action" = 'continued')) THEN
    PERFORM "assert_failover_cutover_authority"(NEW."operation_id");
  END IF;

  IF NEW."state" = 'succeeded' AND NEW."step" = 'fence_source' THEN
    SELECT EXISTS (
      SELECT 1 FROM "agent_failover_step_attempts" attempt
      WHERE attempt."operation_id" = NEW."operation_id" AND attempt."step" = 'cutover'
        AND (attempt."state" = 'succeeded'
          OR (attempt."state" = 'reconciled' AND attempt."reconcile_action" = 'continued'))
    ) INTO cutover_committed;
    IF NOT cutover_committed THEN
      RAISE EXCEPTION 'source fencing requires a committed cutover' USING ERRCODE = '55000';
    END IF;
  END IF;

  NEW."settled_by_lease_owner" := operation."lease_owner";
  NEW."settled_by_lease_generation" := operation."lease_generation";
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_node_failure_events_guard" ON "agent_node_failure_events";
--> statement-breakpoint
CREATE TRIGGER "agent_node_failure_events_guard" BEFORE INSERT OR UPDATE ON "agent_node_failure_events"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_node_failure_event_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_node_failure_signals_guard" ON "agent_node_failure_signals";
--> statement-breakpoint
CREATE TRIGGER "agent_node_failure_signals_guard" BEFORE INSERT OR UPDATE ON "agent_node_failure_signals"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_node_failure_signal_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_failover_operations_guard" ON "agent_failover_operations";
--> statement-breakpoint
CREATE TRIGGER "agent_failover_operations_guard" BEFORE INSERT OR UPDATE ON "agent_failover_operations"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_failover_operation_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_failover_step_attempts_guard" ON "agent_failover_step_attempts";
--> statement-breakpoint
CREATE TRIGGER "agent_failover_step_attempts_guard" BEFORE INSERT OR UPDATE OR DELETE ON "agent_failover_step_attempts"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_failover_step_attempt_write"();
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_node_failure_candidates_guard" ON "agent_node_failure_candidates";
--> statement-breakpoint
CREATE TRIGGER "agent_node_failure_candidates_guard" BEFORE INSERT OR UPDATE OR DELETE ON "agent_node_failure_candidates"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_node_failure_candidate_write"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "guard_agent_failover_operator_action_write"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'operator actions are append-only' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Cascading from a deleted operation is legitimate teardown; erasing a
    -- recorded action out from under a live operation is not.
    IF EXISTS (SELECT 1 FROM "agent_failover_operations" parent
               WHERE parent."id" = OLD."operation_id") THEN
      RAISE EXCEPTION 'a recorded operator action cannot be erased while its operation exists' USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "agent_failover_operator_actions_guard" ON "agent_failover_operator_actions";
--> statement-breakpoint
CREATE TRIGGER "agent_failover_operator_actions_guard" BEFORE INSERT OR UPDATE OR DELETE ON "agent_failover_operator_actions"
  FOR EACH ROW EXECUTE FUNCTION "guard_agent_failover_operator_action_write"();
