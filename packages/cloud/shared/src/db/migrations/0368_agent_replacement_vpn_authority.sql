ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "replacement_cleanup_vpn_authority" jsonb;

--> statement-breakpoint
ALTER TABLE "agent_sandboxes"
  DROP CONSTRAINT IF EXISTS "agent_sandboxes_replacement_vpn_authority_check";
ALTER TABLE "agent_sandboxes"
  ADD CONSTRAINT "agent_sandboxes_replacement_vpn_authority_check" CHECK ((
    replacement_cleanup_vpn_authority IS NULL OR (
      replacement_cleanup_sandbox_id IS NOT NULL
      AND jsonb_typeof(replacement_cleanup_vpn_authority) = 'object'
      AND jsonb_typeof(replacement_cleanup_vpn_authority->'server') = 'object'
      AND jsonb_typeof(replacement_cleanup_vpn_authority->'server'->'apiUrl') = 'string'
      AND length(replacement_cleanup_vpn_authority->'server'->>'apiUrl') > 0
      AND jsonb_typeof(replacement_cleanup_vpn_authority->'server'->'enrollmentUser') = 'string'
      AND length(replacement_cleanup_vpn_authority->'server'->>'enrollmentUser') > 0
      AND (replacement_cleanup_vpn_authority->'server'->>'publicKey') ~ '^mkey:[0-9a-f]{64}$'
      AND replacement_cleanup_vpn_authority->'server'->>'publicKey' <> 'mkey:' || repeat('0', 64)
      AND (
        replacement_cleanup_vpn_authority->'node' = 'null'::jsonb OR (
          jsonb_typeof(replacement_cleanup_vpn_authority->'node') = 'object'
          AND replacement_cleanup_vpn_node_id IS NOT NULL
          AND jsonb_typeof(replacement_cleanup_vpn_authority->'node'->'id') = 'string'
          AND replacement_cleanup_vpn_authority->'node'->>'id' = replacement_cleanup_vpn_node_id
          AND (replacement_cleanup_vpn_authority->'node'->>'id') ~ '^[1-9][0-9]{0,19}$'
          AND (length(replacement_cleanup_vpn_node_id) < 20 OR replacement_cleanup_vpn_node_id <= '18446744073709551615')
          AND (replacement_cleanup_vpn_authority->'node'->>'machineKey') ~ '^mkey:[0-9a-f]{64}$'
          AND replacement_cleanup_vpn_authority->'node'->>'machineKey' <> 'mkey:' || repeat('0', 64)
          AND jsonb_typeof(replacement_cleanup_vpn_authority->'node'->'createdAt') = 'string'
          AND length(replacement_cleanup_vpn_authority->'node'->>'createdAt') > 0
        )
      )
    )
  ) IS TRUE);
