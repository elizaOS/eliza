-- 0073_agent_policy_builder_perps.sql shipped without a journal entry, so the
-- real PostgreSQL migrator never applied it even though PGLite's directory
-- scanner did. Reconcile both fresh and already-migrated PostgreSQL databases
-- at the current journal tip.
ALTER TABLE "agent_policies"
  ADD COLUMN IF NOT EXISTS "allow_builder_perps" boolean DEFAULT false NOT NULL;
