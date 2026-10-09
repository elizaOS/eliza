ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "action_type" varchar(64);
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "action_payload" jsonb;

CREATE INDEX IF NOT EXISTS "transactions_action_type_idx" ON "transactions" ("action_type");
