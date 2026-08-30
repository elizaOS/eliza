-- Adds expiring receipts for encrypted, verifiable recovery-window exports.

CREATE TABLE "account_deletion_exports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "content_digest" text,
  "object_receipt_digest" text,
  "byte_count" bigint,
  "ready_at" timestamp,
  "expires_at" timestamp NOT NULL,
  "deleted_at" timestamp,
  "last_error_code" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "account_deletion_exports_request_unique" UNIQUE("request_id"),
  CONSTRAINT "account_deletion_exports_status_check"
    CHECK ("status" IN ('pending', 'building', 'ready', 'expired', 'deleted', 'failed'))
);
ALTER TABLE "account_deletion_exports" ADD CONSTRAINT
  "account_deletion_exports_request_id_account_deletion_requests_id_fk"
  FOREIGN KEY ("request_id") REFERENCES "public"."account_deletion_requests"("id")
  ON DELETE cascade ON UPDATE no action;
