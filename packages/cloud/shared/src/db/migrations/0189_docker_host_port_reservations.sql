CREATE TABLE IF NOT EXISTS "docker_host_port_reservations" (
  "node_id" text NOT NULL,
  "host_port" integer NOT NULL,
  "owner_kind" text NOT NULL,
  "owner_id" text NOT NULL,
  "port_kind" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "docker_host_port_reservations_pkey"
    PRIMARY KEY ("node_id", "host_port"),
  CONSTRAINT "docker_host_port_reservations_contract_check" CHECK (
    length("node_id") > 0
    AND length("owner_id") > 0
    AND (
      (
        "owner_kind" = 'agent'
        AND (
          (
            "port_kind" = 'agent_bridge'
            AND "host_port" >= 18790
            AND "host_port" < 19790
          )
          OR (
            "port_kind" = 'agent_web'
            AND "host_port" >= 20000
            AND "host_port" < 25000
          )
        )
      )
      OR (
        "owner_kind" = 'restore_validation'
        AND (
          (
            "port_kind" = 'restore_bridge'
            AND "host_port" >= 18790
            AND "host_port" < 19790
          )
          OR (
            "port_kind" = 'restore_web'
            AND "host_port" >= 20000
            AND "host_port" < 25000
          )
        )
      )
      OR (
        "owner_kind" = 'app'
        AND "port_kind" = 'app'
        AND "host_port" >= 20000
        AND "host_port" < 40000
      )
    )
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "docker_host_port_reservations_owner_kind_unique"
  ON "docker_host_port_reservations" (
    "node_id",
    "owner_kind",
    "owner_id",
    "port_kind"
  );

-- During rollback_cleanup_pending the resumed standby is in the primary
-- columns, while the retired blue primary's ports are not persisted in the
-- standby-primary identity. A pre-existing row in that crash window cannot be
-- reconstructed honestly; stop the migration for operator reconciliation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "agent_sandboxes"
    WHERE "rollback_standby_state" = 'rollback_cleanup_pending'
  ) THEN
    RAISE EXCEPTION
      'Docker host-port reservation backfill cannot classify rollback_cleanup_pending blue ports';
  END IF;
END $$;

-- Logical stopped/failed/deleting state is not remote absence proof. Preserve
-- every persisted physical locator during backfill; the normal teardown path
-- releases reservations only after it proves the Docker object absent.
INSERT INTO "docker_host_port_reservations" (
  "node_id",
  "host_port",
  "owner_kind",
  "owner_id",
  "port_kind"
)
SELECT
  "node_id",
  "bridge_port",
  'agent',
  "container_name",
  'agent_bridge'
FROM "agent_sandboxes"
WHERE
  "node_id" IS NOT NULL
  AND "container_name" IS NOT NULL
  AND "bridge_port" IS NOT NULL
ON CONFLICT ("node_id", "host_port") DO NOTHING;

INSERT INTO "docker_host_port_reservations" (
  "node_id",
  "host_port",
  "owner_kind",
  "owner_id",
  "port_kind"
)
SELECT
  "node_id",
  "web_ui_port",
  'agent',
  "container_name",
  'agent_web'
FROM "agent_sandboxes"
WHERE
  "node_id" IS NOT NULL
  AND "container_name" IS NOT NULL
  AND "web_ui_port" IS NOT NULL
ON CONFLICT ("node_id", "host_port") DO NOTHING;

INSERT INTO "docker_host_port_reservations" (
  "node_id",
  "host_port",
  "owner_kind",
  "owner_id",
  "port_kind"
)
SELECT
  "rollback_standby_node_id",
  "rollback_standby_bridge_port",
  'agent',
  "rollback_standby_container_name",
  'agent_bridge'
FROM "agent_sandboxes"
WHERE
  "rollback_standby_node_id" IS NOT NULL
  AND "rollback_standby_container_name" IS NOT NULL
  AND "rollback_standby_bridge_port" IS NOT NULL
  AND (
    "rollback_standby_node_id" IS DISTINCT FROM "node_id"
    OR "rollback_standby_container_name" IS DISTINCT FROM "container_name"
    OR "rollback_standby_bridge_port" IS DISTINCT FROM "bridge_port"
  )
ON CONFLICT ("node_id", "host_port") DO NOTHING;

INSERT INTO "docker_host_port_reservations" (
  "node_id",
  "host_port",
  "owner_kind",
  "owner_id",
  "port_kind"
)
SELECT
  "rollback_standby_node_id",
  "rollback_standby_web_ui_port",
  'agent',
  "rollback_standby_container_name",
  'agent_web'
FROM "agent_sandboxes"
WHERE
  "rollback_standby_node_id" IS NOT NULL
  AND "rollback_standby_container_name" IS NOT NULL
  AND "rollback_standby_web_ui_port" IS NOT NULL
  AND (
    "rollback_standby_node_id" IS DISTINCT FROM "node_id"
    OR "rollback_standby_container_name" IS DISTINCT FROM "container_name"
    OR "rollback_standby_web_ui_port" IS DISTINCT FROM "web_ui_port"
  )
ON CONFLICT ("node_id", "host_port") DO NOTHING;

INSERT INTO "docker_host_port_reservations" (
  "node_id",
  "host_port",
  "owner_kind",
  "owner_id",
  "port_kind"
)
SELECT
  "target_provider_node_id",
  "target_provider_bridge_port",
  'restore_validation',
  "target_provider_container_name",
  'restore_bridge'
FROM "agent_snapshot_restore_validations"
WHERE
  "target_provider_allocation_counted" = TRUE
  AND "target_provider_node_id" IS NOT NULL
  AND "target_provider_container_name" IS NOT NULL
  AND "target_provider_bridge_port" IS NOT NULL
ON CONFLICT ("node_id", "host_port") DO NOTHING;

INSERT INTO "docker_host_port_reservations" (
  "node_id",
  "host_port",
  "owner_kind",
  "owner_id",
  "port_kind"
)
SELECT
  "target_provider_node_id",
  "target_provider_web_ui_port",
  'restore_validation',
  "target_provider_container_name",
  'restore_web'
FROM "agent_snapshot_restore_validations"
WHERE
  "target_provider_allocation_counted" = TRUE
  AND "target_provider_node_id" IS NOT NULL
  AND "target_provider_container_name" IS NOT NULL
  AND "target_provider_web_ui_port" IS NOT NULL
ON CONFLICT ("node_id", "host_port") DO NOTHING;

INSERT INTO "docker_host_port_reservations" (
  "node_id",
  "host_port",
  "owner_kind",
  "owner_id",
  "port_kind"
)
SELECT
  "node_id",
  ("metadata" ->> 'hostPort')::integer,
  'app',
  "name",
  'app'
FROM "containers"
WHERE
  "node_id" IS NOT NULL
  AND jsonb_typeof("metadata" -> 'hostPort') = 'number'
ON CONFLICT ("node_id", "host_port") DO NOTHING;

DO $$
DECLARE
  expected_count bigint;
  actual_count bigint;
BEGIN
  SELECT
    (
      SELECT count(*)
      FROM "agent_sandboxes"
      WHERE
        "node_id" IS NOT NULL
        AND "container_name" IS NOT NULL
        AND "bridge_port" IS NOT NULL
    )
    + (
      SELECT count(*)
      FROM "agent_sandboxes"
      WHERE
        "node_id" IS NOT NULL
        AND "container_name" IS NOT NULL
        AND "web_ui_port" IS NOT NULL
    )
    + (
      SELECT count(*)
      FROM "agent_sandboxes"
      WHERE
        "rollback_standby_node_id" IS NOT NULL
        AND "rollback_standby_container_name" IS NOT NULL
        AND "rollback_standby_bridge_port" IS NOT NULL
        AND (
          "rollback_standby_node_id" IS DISTINCT FROM "node_id"
          OR "rollback_standby_container_name" IS DISTINCT FROM "container_name"
          OR "rollback_standby_bridge_port" IS DISTINCT FROM "bridge_port"
        )
    )
    + (
      SELECT count(*)
      FROM "agent_sandboxes"
      WHERE
        "rollback_standby_node_id" IS NOT NULL
        AND "rollback_standby_container_name" IS NOT NULL
        AND "rollback_standby_web_ui_port" IS NOT NULL
        AND (
          "rollback_standby_node_id" IS DISTINCT FROM "node_id"
          OR "rollback_standby_container_name" IS DISTINCT FROM "container_name"
          OR "rollback_standby_web_ui_port" IS DISTINCT FROM "web_ui_port"
        )
    )
    + (
      SELECT count(*)
      FROM "agent_snapshot_restore_validations"
      WHERE
        "target_provider_allocation_counted" = TRUE
        AND "target_provider_node_id" IS NOT NULL
        AND "target_provider_container_name" IS NOT NULL
        AND "target_provider_bridge_port" IS NOT NULL
    )
    + (
      SELECT count(*)
      FROM "agent_snapshot_restore_validations"
      WHERE
        "target_provider_allocation_counted" = TRUE
        AND "target_provider_node_id" IS NOT NULL
        AND "target_provider_container_name" IS NOT NULL
        AND "target_provider_web_ui_port" IS NOT NULL
    )
    + (
      SELECT count(*)
      FROM "containers"
      WHERE
        "node_id" IS NOT NULL
        AND jsonb_typeof("metadata" -> 'hostPort') = 'number'
    )
  INTO expected_count;

  SELECT count(*) INTO actual_count FROM "docker_host_port_reservations";
  IF actual_count <> expected_count THEN
    RAISE EXCEPTION
      'Docker host-port reservation backfill detected an existing collision (% expected, % reserved)',
      expected_count,
      actual_count;
  END IF;
END $$;

DROP INDEX IF EXISTS "agent_sandboxes_node_bridge_port_uniq";
DROP INDEX IF EXISTS "agent_sandboxes_node_webui_port_uniq";
DROP INDEX IF EXISTS "agent_snapshot_restore_validations_node_bridge_port_unique";
DROP INDEX IF EXISTS "agent_snapshot_restore_validations_node_web_ui_port_unique";
