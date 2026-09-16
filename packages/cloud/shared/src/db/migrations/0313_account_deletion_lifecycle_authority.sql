-- Adds the primary-writer account authority and extends the durable request receipt.

ALTER TABLE "organizations" ADD COLUMN "account_lifecycle_state" text DEFAULT 'active' NOT NULL;
ALTER TABLE "organizations" ADD COLUMN "account_lifecycle_revision" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "organizations" ADD COLUMN "account_deletion_request_id" uuid;
ALTER TABLE "organizations" ADD COLUMN "paid_work_fenced_at" timestamp;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_account_lifecycle_state_check"
  CHECK ("account_lifecycle_state" IN ('active', 'deletion_recovery', 'deletion_irreversible'));
CREATE INDEX "organizations_account_deletion_request_idx"
  ON "organizations" USING btree ("account_deletion_request_id");

ALTER TABLE "users" ADD COLUMN "account_lifecycle_state" text DEFAULT 'active' NOT NULL;
ALTER TABLE "users" ADD COLUMN "account_lifecycle_revision" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "users" ADD COLUMN "account_deletion_request_id" uuid;
ALTER TABLE "users" ADD COLUMN "auth_fenced_at" timestamp;
ALTER TABLE "users" ADD CONSTRAINT "users_account_lifecycle_state_check"
  CHECK ("account_lifecycle_state" IN ('active', 'deletion_recovery', 'deletion_irreversible'));
CREATE INDEX "users_account_deletion_request_idx"
  ON "users" USING btree ("account_deletion_request_id");

ALTER TABLE "account_deletion_requests" ALTER COLUMN "status" SET DEFAULT 'reserved';
ALTER TABLE "account_deletion_requests" ADD COLUMN "operation_kind" text
  DEFAULT 'personal_account_deletion' NOT NULL;
ALTER TABLE "account_deletion_requests" ADD COLUMN "lifecycle_revision" bigint DEFAULT 1 NOT NULL;
ALTER TABLE "account_deletion_requests" ADD COLUMN "lease_generation" bigint DEFAULT 0 NOT NULL;
ALTER TABLE "account_deletion_requests" ADD COLUMN "lease_expires_at" timestamp;
ALTER TABLE "account_deletion_requests" ADD COLUMN "status_token_hash" text;
ALTER TABLE "account_deletion_requests" ADD COLUMN "status_token_expires_at" timestamp;
ALTER TABLE "account_deletion_requests" ADD COLUMN "recovery_token_hash" text;
ALTER TABLE "account_deletion_requests" ADD COLUMN "recovery_token_expires_at" timestamp;
ALTER TABLE "account_deletion_requests" ADD COLUMN "request_digest" text;
ALTER TABLE "account_deletion_requests" ADD COLUMN "restore_auto_top_up_enabled" boolean;
ALTER TABLE "account_deletion_requests" ADD COLUMN "restore_pay_as_you_go_from_earnings" boolean;
ALTER TABLE "account_deletion_requests" ADD COLUMN "recovery_expires_at" timestamp;
ALTER TABLE "account_deletion_requests" ADD COLUMN "irreversible_at" timestamp;
ALTER TABLE "account_deletion_requests" ADD COLUMN "canceled_at" timestamp;
ALTER TABLE "account_deletion_requests" ADD COLUMN "completion_receipt_digest" text;
ALTER TABLE "account_deletion_requests" ADD COLUMN "failure_class" text;
ALTER TABLE "account_deletion_requests" ADD COLUMN "next_reconcile_at" timestamp;

ALTER TABLE "account_deletion_requests" DROP CONSTRAINT "account_deletion_requests_status_check";
ALTER TABLE "account_deletion_requests" DROP CONSTRAINT "account_deletion_requests_attempts_check";
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_status_check"
  CHECK ("status" IN ('requested', 'reserved', 'recovery', 'scheduled', 'processing',
    'completed', 'canceled', 'action_required'));
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_operation_kind_check"
  CHECK ("operation_kind" = 'personal_account_deletion');
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_attempts_check"
  CHECK ("attempts" >= 0 AND "max_attempts" > 0 AND "lifecycle_revision" > 0
    AND "lease_generation" >= 0);
CREATE UNIQUE INDEX "account_deletion_requests_status_token_idx"
  ON "account_deletion_requests" USING btree ("status_token_hash")
  WHERE "status_token_hash" IS NOT NULL;
CREATE UNIQUE INDEX "account_deletion_requests_recovery_token_idx"
  ON "account_deletion_requests" USING btree ("recovery_token_hash")
  WHERE "recovery_token_hash" IS NOT NULL;
DROP INDEX "account_deletion_requests_one_open_user_idx";
CREATE UNIQUE INDEX "account_deletion_requests_one_open_user_idx"
  ON "account_deletion_requests" USING btree ("user_id")
  WHERE "status" NOT IN ('completed', 'canceled') AND "user_id" IS NOT NULL;
