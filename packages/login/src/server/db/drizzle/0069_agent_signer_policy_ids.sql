ALTER TABLE "agent_signers"
ADD COLUMN IF NOT EXISTS "policy_ids" text[] NOT NULL DEFAULT '{}';
