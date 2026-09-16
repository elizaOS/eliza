ALTER TABLE "agent_policies"
  ADD COLUMN IF NOT EXISTS "allow_builder_perps" boolean DEFAULT false NOT NULL;
