-- Serializes provider dispatch with account-lifecycle activation under the organization row lock.

CREATE TABLE "provider_admissions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "operation_kind" text NOT NULL,
  "operation_id" uuid NOT NULL,
  "admitted_at" timestamp with time zone NOT NULL,
  "released_at" timestamp with time zone,
  CONSTRAINT "provider_admissions_organization_id_organizations_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id")
    ON DELETE cascade ON UPDATE no action
);

CREATE UNIQUE INDEX "provider_admissions_operation_idx"
  ON "provider_admissions" USING btree ("operation_kind", "operation_id");
CREATE INDEX "provider_admissions_active_organization_idx"
  ON "provider_admissions" USING btree ("organization_id", "released_at");
