-- Creates the durable fault records and failover work for a lost node occurrence.

CREATE TABLE IF NOT EXISTS "agent_node_failure_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "node_record_id" uuid NOT NULL,
  "node_id" text NOT NULL,
  "node_incarnation" uuid NOT NULL,
  "node_history_id" uuid NOT NULL,
  "status" text NOT NULL DEFAULT 'collecting',
  "corroboration_required" integer NOT NULL DEFAULT 2,
  "first_observed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_observed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "triggered_at" timestamp with time zone,
  "cordoned_at" timestamp with time zone,
  "enumerated_at" timestamp with time zone,
  "closed_at" timestamp with time zone,
  "closure_reason" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_node_failure_events_node_record_fkey"
    FOREIGN KEY ("node_record_id") REFERENCES "docker_nodes"("id") ON DELETE RESTRICT,
  CONSTRAINT "agent_node_failure_events_occurrence_fkey"
    FOREIGN KEY ("node_history_id", "node_record_id", "node_incarnation")
    REFERENCES "agent_node_incarnation_histories"("id", "docker_node_record_id", "node_incarnation")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_node_failure_events_occurrence_authority_unique"
    UNIQUE ("id", "node_record_id", "node_incarnation", "node_history_id"),
  CONSTRAINT "agent_node_failure_events_corroboration_floor_check"
    CHECK ("corroboration_required" BETWEEN 2 AND 16),
  CONSTRAINT "agent_node_failure_events_lifecycle_shape_check" CHECK ((
    "node_id" = btrim("node_id")
    AND octet_length("node_id") BETWEEN 1 AND 255
    AND "last_observed_at" >= "first_observed_at"
    AND ("status" <> 'triggered' OR "triggered_at" IS NOT NULL)
    AND ("status" <> 'collecting' OR "triggered_at" IS NULL)
    AND ("status" <> 'inconclusive' OR "triggered_at" IS NULL)
    AND (("status" IN ('cleared', 'inconclusive')) = ("closed_at" IS NOT NULL))
    AND (("closure_reason" IS NULL) = ("closed_at" IS NULL))
    AND (("cordoned_at" IS NULL) = ("enumerated_at" IS NULL))
    AND ("cordoned_at" IS NULL
      OR ("cordoned_at" >= "created_at" AND "enumerated_at" >= "cordoned_at"))) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_node_failure_events_open_occurrence_uidx"
  ON "agent_node_failure_events" ("node_record_id", "node_incarnation", "node_history_id")
  WHERE "status" IN ('collecting', 'triggered');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_node_failure_events_open_status_idx"
  ON "agent_node_failure_events" ("status", "last_observed_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_node_failure_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "failure_event_id" uuid NOT NULL,
  "kind" text NOT NULL,
  "source" text NOT NULL,
  "source_class" text NOT NULL,
  "policy_version" integer NOT NULL,
  "observation_count" integer NOT NULL DEFAULT 1,
  "first_observed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_observed_at" timestamp with time zone NOT NULL DEFAULT now(),
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_node_failure_signals_event_fkey"
    FOREIGN KEY ("failure_event_id") REFERENCES "agent_node_failure_events"("id")
    ON DELETE CASCADE,
  CONSTRAINT "agent_node_failure_signals_shape_check" CHECK ((
    "kind" IN ('node_heartbeat_expired', 'node_probe_unreachable',
      'node_control_plane_unreachable', 'container_runtime_absent',
      'provider_reported_failure', 'placement_attestation_missing')
    AND "source" IN ('platform_heartbeat_monitor', 'platform_placement_probe',
      'platform_control_plane_probe', 'platform_runtime_inventory',
      'infrastructure_provider_api')
    AND "source_class" IN ('platform_reachability', 'platform_runtime_state',
      'infrastructure_provider')
    AND (("source" = 'infrastructure_provider_api'
        AND "source_class" = 'infrastructure_provider')
      OR ("source" = 'platform_runtime_inventory'
        AND "source_class" = 'platform_runtime_state')
      OR ("source" IN ('platform_heartbeat_monitor', 'platform_placement_probe',
          'platform_control_plane_probe')
        AND "source_class" = 'platform_reachability'))
    AND "policy_version" >= 1
    AND "observation_count" >= 1
    AND "last_observed_at" >= "first_observed_at"
    AND jsonb_typeof("detail") = 'object') IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_node_failure_signals_evidence_uidx"
  ON "agent_node_failure_signals" ("failure_event_id", "kind", "source");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_node_failure_signals_event_class_idx"
  ON "agent_node_failure_signals" ("failure_event_id", "source_class");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_node_failure_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "failure_event_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "source_publication_id" uuid NOT NULL,
  "source_activation_generation" uuid NOT NULL,
  "source_lifecycle_revision" bigint NOT NULL,
  "source_container_id" text NOT NULL,
  "source_container_name" text,
  "frozen_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_node_failure_candidates_event_fkey"
    FOREIGN KEY ("failure_event_id") REFERENCES "agent_node_failure_events"("id")
    ON DELETE CASCADE,
  CONSTRAINT "agent_node_failure_candidates_agent_tenant_fkey"
    FOREIGN KEY ("agent_id", "organization_id")
    REFERENCES "agent_sandboxes"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_node_failure_candidates_candidate_uidx"
    UNIQUE ("failure_event_id", "agent_id"),
  CONSTRAINT "agent_node_failure_candidates_shape_check" CHECK ((
    "source_container_id" ~ '^[0-9a-f]{64}$'
    AND "source_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND ("source_container_name" IS NULL
      OR ("source_container_name" = btrim("source_container_name")
        AND octet_length("source_container_name") BETWEEN 1 AND 255))) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_node_failure_candidates_publication_uidx"
  ON "agent_node_failure_candidates" ("failure_event_id", "source_publication_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_node_failure_candidates_event_idx"
  ON "agent_node_failure_candidates" ("failure_event_id", "frozen_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_failover_operations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "failure_event_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "agent_id" uuid NOT NULL,
  "source_node_record_id" uuid NOT NULL,
  "source_node_id" text NOT NULL,
  "source_node_incarnation" uuid NOT NULL,
  "source_node_history_id" uuid NOT NULL,
  "source_container_name" text,
  "source_publication_id" uuid NOT NULL,
  "source_activation_generation" uuid NOT NULL,
  "source_lifecycle_revision" bigint NOT NULL,
  "source_container_id" text NOT NULL,
  "source_data_watermark_at" timestamp with time zone,
  "restore_operation_id" uuid,
  "restore_lease_id" uuid,
  "restore_lease_owner" text,
  "restore_lease_generation" uuid,
  "replacement_attempt_id" uuid,
  "restore_backup_id" uuid,
  "restore_manifest_sha256" text,
  "target_node_record_id" uuid,
  "target_node_incarnation" uuid,
  "target_node_history_id" uuid,
  "target_publication_id" uuid,
  "target_activation_generation" uuid,
  "target_lifecycle_revision" bigint,
  "target_container_id" text,
  "target_receipt_sha256" text,
  "status" text NOT NULL DEFAULT 'pending',
  "step" text NOT NULL DEFAULT 'isolate_source',
  "step_state" text NOT NULL DEFAULT 'not_started',
  "lease_owner" text,
  "lease_generation" uuid,
  "lease_expires_at" timestamp with time zone,
  "lease_heartbeat_at" timestamp with time zone,
  "claim_count" integer NOT NULL DEFAULT 0,
  "wait_reason" text,
  "wait_deadline_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  "post_cutover_attempts" integer NOT NULL DEFAULT 0,
  "last_error_code" text,
  "last_error_message" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "agent_failover_operations_failure_occurrence_fkey"
    FOREIGN KEY ("failure_event_id", "source_node_record_id", "source_node_incarnation",
      "source_node_history_id")
    REFERENCES "agent_node_failure_events"("id", "node_record_id", "node_incarnation",
      "node_history_id")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_failover_operations_source_occurrence_fkey"
    FOREIGN KEY ("source_node_history_id", "source_node_record_id", "source_node_incarnation")
    REFERENCES "agent_node_incarnation_histories"("id", "docker_node_record_id", "node_incarnation")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_failover_operations_agent_tenant_fkey"
    FOREIGN KEY ("agent_id", "organization_id")
    REFERENCES "agent_sandboxes"("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "agent_failover_operations_source_publication_fkey"
    FOREIGN KEY ("source_publication_id") REFERENCES "agent_activation_publications"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_failover_operations_restore_operation_fkey"
    FOREIGN KEY ("restore_operation_id") REFERENCES "agent_backup_restore_operations"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_failover_operations_restore_lease_fkey"
    FOREIGN KEY ("restore_lease_id") REFERENCES "agent_backup_restore_leases"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_failover_operations_replacement_attempt_fkey"
    FOREIGN KEY ("replacement_attempt_id") REFERENCES "agent_sandbox_replacement_attempts"("id")
    ON DELETE RESTRICT,
  CONSTRAINT "agent_failover_operations_target_node_fkey"
    FOREIGN KEY ("target_node_record_id") REFERENCES "docker_nodes"("id") ON DELETE RESTRICT,
  CONSTRAINT "agent_failover_operations_failure_agent_uidx"
    UNIQUE ("failure_event_id", "agent_id"),
  CONSTRAINT "agent_failover_operations_lease_shape_check" CHECK ((
    (("lease_owner" IS NULL AND "lease_generation" IS NULL
        AND "lease_expires_at" IS NULL AND "lease_heartbeat_at" IS NULL)
      OR ("lease_owner" IS NOT NULL AND "lease_generation" IS NOT NULL
        AND "lease_expires_at" IS NOT NULL AND "lease_heartbeat_at" IS NOT NULL
        AND "lease_owner" = btrim("lease_owner")
        AND octet_length("lease_owner") BETWEEN 1 AND 255))
    AND "claim_count" >= 0
    AND "post_cutover_attempts" >= 0
    AND "step" IN ('isolate_source', 'check_preconditions', 'restore', 'verify', 'cutover',
      'fence_source')
    AND "step_state" IN ('not_started', 'in_progress', 'awaiting_reconcile', 'succeeded', 'failed')
    AND (("status" IN ('pending', 'running', 'awaiting_capacity', 'awaiting_reconcile',
        'restore_release_required', 'intervention_required')) = ("completed_at" IS NULL))
    AND ("status" IN ('pending', 'running', 'awaiting_capacity', 'awaiting_reconcile', 'completed')
      OR ("lease_owner" IS NULL AND "lease_generation" IS NULL
        AND "lease_expires_at" IS NULL AND "lease_heartbeat_at" IS NULL))
    AND ("status" <> 'awaiting_capacity'
      OR ("wait_reason" IS NOT NULL AND "wait_deadline_at" IS NOT NULL
        AND "target_publication_id" IS NULL))
    AND ("status" = 'awaiting_capacity'
      OR ("wait_reason" IS NULL AND "wait_deadline_at" IS NULL))
    AND ("wait_reason" IS NULL
      OR "wait_reason" IN ('no_target_capacity', 'source_contended', 'restore_target_unavailable'))
    AND (("status" IN ('pending', 'completed') AND "last_error_code" IS NULL)
      OR ("status" IN ('failed', 'cancelled', 'blocked_no_backup', 'intervention_required')
        AND "last_error_code" IS NOT NULL)
      OR "status" IN ('running', 'awaiting_capacity', 'awaiting_reconcile',
        'restore_release_required'))
    AND "source_node_id" = btrim("source_node_id")
    AND octet_length("source_node_id") BETWEEN 1 AND 255
    AND ("source_container_name" IS NULL
      OR ("source_container_name" = btrim("source_container_name")
        AND octet_length("source_container_name") BETWEEN 1 AND 255))
    AND "source_container_id" ~ '^[0-9a-f]{64}$'
    AND ("last_error_code" IS NULL
      OR ("last_error_code" = btrim("last_error_code")
        AND octet_length("last_error_code") BETWEEN 1 AND 128))
    AND ("started_at" IS NULL OR "started_at" >= "created_at")
    AND ("completed_at" IS NULL OR "completed_at" >= "created_at")
    AND (("target_node_record_id" IS NULL) = ("target_node_incarnation" IS NULL))
    AND (("target_node_record_id" IS NULL) = ("target_node_history_id" IS NULL))
    AND (("restore_operation_id" IS NULL) = ("restore_lease_id" IS NULL))
    AND (("restore_lease_id" IS NULL) = ("restore_lease_generation" IS NULL))
    AND (("restore_backup_id" IS NULL) = ("restore_manifest_sha256" IS NULL))
    AND ("target_publication_id" IS NULL
      OR ("restore_backup_id" IS NOT NULL AND "target_container_id" IS NOT NULL
        AND "target_activation_generation" IS NOT NULL
        AND "target_lifecycle_revision" IS NOT NULL
        AND "target_receipt_sha256" IS NOT NULL))) IS TRUE),
  CONSTRAINT "agent_failover_operations_source_shape_check" CHECK ((
    "source_lifecycle_revision" BETWEEN 0 AND 18446744073709551615
    AND ("source_activation_generation" <> "target_activation_generation"
      OR "target_activation_generation" IS NULL)
    AND ("target_lifecycle_revision" IS NULL
      OR "target_lifecycle_revision" > "source_lifecycle_revision")) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_failover_operations_active_agent_uidx"
  ON "agent_failover_operations" ("agent_id")
  WHERE "status" IN ('pending', 'running', 'awaiting_capacity', 'awaiting_reconcile',
    'restore_release_required', 'intervention_required');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_failover_operations_claim_due_idx"
  ON "agent_failover_operations" ("status", "next_attempt_at")
  WHERE "status" IN ('pending', 'running', 'awaiting_capacity', 'awaiting_reconcile',
    'restore_release_required', 'intervention_required');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_failover_operations_lease_horizon_idx"
  ON "agent_failover_operations" ("lease_expires_at")
  WHERE "lease_generation" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_failover_operations_target_node_idx"
  ON "agent_failover_operations" ("target_node_record_id")
  WHERE "target_node_record_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_failover_operations_agent_idx"
  ON "agent_failover_operations" ("agent_id", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_failover_operations_organization_idx"
  ON "agent_failover_operations" ("organization_id", "created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_failover_operator_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "operation_id" uuid NOT NULL,
  "action" text NOT NULL,
  "operator" text NOT NULL,
  "reason" text NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_failover_operator_actions_operation_fkey"
    FOREIGN KEY ("operation_id") REFERENCES "agent_failover_operations"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_failover_operator_actions_shape_check" CHECK ((
    "action" IN ('resume')
    AND "operator" = btrim("operator")
    AND octet_length("operator") BETWEEN 1 AND 255
    AND "reason" = btrim("reason")
    AND octet_length("reason") BETWEEN 1 AND 1024) IS TRUE)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_failover_operator_actions_operation_idx"
  ON "agent_failover_operator_actions" ("operation_id", "recorded_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_failover_step_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "operation_id" uuid NOT NULL,
  "step" text NOT NULL,
  "attempt" integer NOT NULL,
  "state" text NOT NULL,
  "lease_owner" text NOT NULL,
  "lease_generation" uuid NOT NULL,
  "settled_by_lease_owner" text,
  "settled_by_lease_generation" uuid,
  "detail" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "reconcile_action" text,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "finished_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "agent_failover_step_attempts_operation_fkey"
    FOREIGN KEY ("operation_id") REFERENCES "agent_failover_operations"("id") ON DELETE CASCADE,
  CONSTRAINT "agent_failover_step_attempts_shape_check" CHECK ((
    "step" IN ('isolate_source', 'check_preconditions', 'restore', 'verify', 'cutover',
      'fence_source')
    AND "attempt" >= 1
    AND "state" IN ('started', 'succeeded', 'failed', 'awaiting_reconcile', 'reconciled',
      'abandoned')
    AND "lease_owner" = btrim("lease_owner")
    AND octet_length("lease_owner") BETWEEN 1 AND 255
    AND jsonb_typeof("detail") = 'object'
    AND (("state" = 'started') = ("finished_at" IS NULL))
    AND (("state" = 'started') = ("settled_by_lease_owner" IS NULL))
    AND (("settled_by_lease_owner" IS NULL) = ("settled_by_lease_generation" IS NULL))
    AND ("finished_at" IS NULL OR "finished_at" >= "started_at")
    AND (("state" = 'reconciled') = ("reconcile_action" IS NOT NULL))
    AND ("state" <> 'reconciled' OR "detail" <> '{}'::jsonb)
    AND ("reconcile_action" IS NULL
      OR "reconcile_action" IN ('continued', 'retried', 'abandoned'))) IS TRUE)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_failover_step_attempts_attempt_uidx"
  ON "agent_failover_step_attempts" ("operation_id", "step", "attempt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_failover_step_attempts_operation_started_idx"
  ON "agent_failover_step_attempts" ("operation_id", "started_at");
