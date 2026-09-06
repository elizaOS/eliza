ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_vpn_authority" jsonb;
