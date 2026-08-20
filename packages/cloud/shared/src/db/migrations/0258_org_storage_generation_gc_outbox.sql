-- Adds durable garbage collection for superseded immutable storage generations.
CREATE TABLE "org_storage_gc_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE RESTRICT,
  "operation_id" uuid NOT NULL
    REFERENCES "org_storage_put_operations"("id") ON DELETE CASCADE,
  "provider_key" text NOT NULL,
  "state" text DEFAULT 'pending' NOT NULL,
  "not_before" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "org_storage_gc_outbox_shape_check" CHECK (
    "state" IN ('pending','completed')
    AND ("state" <> 'completed' OR "completed_at" IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE UNIQUE INDEX "org_storage_gc_outbox_operation_uidx"
  ON "org_storage_gc_outbox"("operation_id");
--> statement-breakpoint
CREATE INDEX "org_storage_gc_outbox_due_idx"
  ON "org_storage_gc_outbox"("state", "not_before");
