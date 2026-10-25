-- Adds response-loss-safe deletion admission authority without persisting bearer plaintext.

ALTER TABLE "account_deletion_requests" ADD COLUMN "admission_token_hash" text;
ALTER TABLE "account_deletion_requests" ADD COLUMN "admission_token_expires_at" timestamp;

ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_admission_pair_check"
  CHECK (("admission_token_hash" IS NULL) = ("admission_token_expires_at" IS NULL));

CREATE UNIQUE INDEX "account_deletion_requests_admission_token_idx"
  ON "account_deletion_requests" USING btree ("admission_token_hash")
  WHERE "account_deletion_requests"."admission_token_hash" IS NOT NULL;
