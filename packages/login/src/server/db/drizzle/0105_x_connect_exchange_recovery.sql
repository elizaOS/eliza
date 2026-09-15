ALTER TABLE "provider_x_credential_lifecycles"
  ADD COLUMN "kind" varchar(32) NOT NULL DEFAULT 'refresh_rotation',
  ADD COLUMN "attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN "next_retry_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "provider_x_credential_lifecycles"
  ALTER COLUMN "provider_account_id" DROP NOT NULL,
  ALTER COLUMN "expected_account_revision" DROP NOT NULL,
  DROP CONSTRAINT "provider_x_lifecycle_revision_check",
  ADD CONSTRAINT "provider_x_lifecycle_revision_check"
    CHECK ("expected_account_revision" IS NULL OR "expected_account_revision" >= 1),
  ADD CONSTRAINT "provider_x_lifecycle_kind_check"
    CHECK ("kind" IN ('connect_exchange', 'refresh_rotation')),
  ADD CONSTRAINT "provider_x_lifecycle_refresh_binding_check"
    CHECK ("kind" <> 'refresh_rotation' OR ("provider_account_id" IS NOT NULL AND "expected_account_revision" IS NOT NULL));
--> statement-breakpoint
UPDATE "provider_x_credential_lifecycles"
SET "next_retry_at" = now()
WHERE "state" = 'revocation_pending';
--> statement-breakpoint
UPDATE "provider_x_credential_lifecycles"
SET "state" = 'revocation_pending', "next_retry_at" = now()
WHERE "state" = 'needs_attention' AND "credential_secret_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "provider_x_credential_lifecycles"
  ADD CONSTRAINT "provider_x_lifecycle_retry_check"
    CHECK ("attempts" >= 0 AND "attempts" <= 5 AND ("state" <> 'revocation_pending' OR "next_retry_at" IS NOT NULL));
--> statement-breakpoint
DROP INDEX "provider_x_lifecycle_active_refresh_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "provider_x_lifecycle_active_refresh_idx"
  ON "provider_x_credential_lifecycles" USING btree ("tenant_id", "provider_account_id")
  WHERE "kind" = 'refresh_rotation'
    AND "state" IN ('inflight', 'credential_staged', 'revocation_pending', 'needs_attention');
--> statement-breakpoint
CREATE INDEX "provider_x_lifecycle_recovery_idx"
  ON "provider_x_credential_lifecycles" USING btree ("state", "next_retry_at", "updated_at");
