BEGIN;
--> statement-breakpoint
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "agent_id", "provider", "external_id"
      ORDER BY
        CASE "role" WHEN 'OWNER' THEN 0 WHEN 'TEAM' THEN 1 ELSE 2 END,
        "created_at",
        "id"
    ) AS sibling_rank
  FROM "connector_accounts"
  WHERE "deleted_at" IS NULL AND "external_id" IS NOT NULL
)
UPDATE "connector_accounts" AS account
SET
  "status" = 'disabled',
  "deleted_at" = CURRENT_TIMESTAMP,
  "updated_at" = CURRENT_TIMESTAMP
FROM ranked
WHERE account."id" = ranked."id" AND ranked.sibling_rank > 1;
--> statement-breakpoint
DROP INDEX IF EXISTS "connector_accounts_agent_provider_external_role_uniq";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connector_accounts_agent_provider_external_uniq"
  ON "connector_accounts" USING btree ("agent_id", "provider", "external_id")
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
COMMIT;
