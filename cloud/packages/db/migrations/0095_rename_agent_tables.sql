DO $$
BEGIN
  IF to_regclass('public.eliza_sandboxes') IS NOT NULL
    AND to_regclass('public.agent_sandboxes') IS NULL THEN
    ALTER TABLE "eliza_sandboxes" RENAME TO "agent_sandboxes";
  END IF;

  IF to_regclass('public.eliza_sandbox_backups') IS NOT NULL
    AND to_regclass('public.agent_sandbox_backups') IS NULL THEN
    ALTER TABLE "eliza_sandbox_backups" RENAME TO "agent_sandbox_backups";
  END IF;

  IF to_regclass('public.eliza_pairing_tokens') IS NOT NULL
    AND to_regclass('public.agent_pairing_tokens') IS NULL THEN
    ALTER TABLE "eliza_pairing_tokens" RENAME TO "agent_pairing_tokens";
  END IF;
END $$;

UPDATE "jobs"
SET "type" = 'agent_provision'
WHERE "type" = 'eliza_provision';

DO $$
DECLARE
  rename_constraint record;
BEGIN
  FOR rename_constraint IN
    SELECT * FROM (VALUES
      ('agent_sandboxes', 'eliza_sandboxes_pkey', 'agent_sandboxes_pkey'),
      ('agent_sandboxes', 'eliza_sandboxes_organization_id_fkey', 'agent_sandboxes_organization_id_fkey'),
      ('agent_sandboxes', 'eliza_sandboxes_user_id_fkey', 'agent_sandboxes_user_id_fkey'),
      ('agent_sandboxes', 'eliza_sandboxes_character_id_fkey', 'agent_sandboxes_character_id_fkey'),
      ('agent_sandbox_backups', 'eliza_sandbox_backups_pkey', 'agent_sandbox_backups_pkey'),
      ('agent_sandbox_backups', 'eliza_sandbox_backups_sandbox_record_id_fkey', 'agent_sandbox_backups_sandbox_record_id_fkey'),
      ('agent_pairing_tokens', 'eliza_pairing_tokens_pkey', 'agent_pairing_tokens_pkey'),
      ('agent_pairing_tokens', 'eliza_pairing_tokens_token_hash_unique', 'agent_pairing_tokens_token_hash_unique'),
      ('agent_pairing_tokens', 'eliza_pairing_tokens_organization_id_fkey', 'agent_pairing_tokens_organization_id_fkey'),
      ('agent_pairing_tokens', 'eliza_pairing_tokens_user_id_fkey', 'agent_pairing_tokens_user_id_fkey'),
      ('agent_pairing_tokens', 'eliza_pairing_tokens_agent_id_fkey', 'agent_pairing_tokens_agent_id_fkey')
    ) AS constraint_names(table_name, old_name, new_name)
  LOOP
    IF to_regclass(format('public.%I', rename_constraint.table_name)) IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = to_regclass(format('public.%I', rename_constraint.table_name))
          AND conname = rename_constraint.old_name
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = to_regclass(format('public.%I', rename_constraint.table_name))
          AND conname = rename_constraint.new_name
      ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
        rename_constraint.table_name,
        rename_constraint.old_name,
        rename_constraint.new_name
      );
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  rename_index record;
BEGIN
  FOR rename_index IN
    SELECT * FROM (VALUES
      ('eliza_sandboxes_organization_idx', 'agent_sandboxes_organization_idx'),
      ('eliza_sandboxes_user_idx', 'agent_sandboxes_user_idx'),
      ('eliza_sandboxes_status_idx', 'agent_sandboxes_status_idx'),
      ('eliza_sandboxes_character_idx', 'agent_sandboxes_character_idx'),
      ('eliza_sandboxes_sandbox_id_idx', 'agent_sandboxes_sandbox_id_idx'),
      ('eliza_sandboxes_node_id_idx', 'agent_sandboxes_node_id_idx'),
      ('eliza_sandboxes_node_bridge_port_uniq', 'agent_sandboxes_node_bridge_port_uniq'),
      ('eliza_sandboxes_node_webui_port_uniq', 'agent_sandboxes_node_webui_port_uniq'),
      ('eliza_sandboxes_billing_status_idx', 'agent_sandboxes_billing_status_idx'),
      ('eliza_sandbox_backups_sandbox_idx', 'agent_sandbox_backups_sandbox_idx'),
      ('eliza_sandbox_backups_created_at_idx', 'agent_sandbox_backups_created_at_idx'),
      ('eliza_pairing_tokens_token_hash_idx', 'agent_pairing_tokens_token_hash_idx'),
      ('eliza_pairing_tokens_expires_at_idx', 'agent_pairing_tokens_expires_at_idx'),
      ('eliza_pairing_tokens_agent_id_idx', 'agent_pairing_tokens_agent_id_idx')
    ) AS index_names(old_name, new_name)
  LOOP
    IF to_regclass(format('public.%I', rename_index.old_name)) IS NOT NULL
      AND to_regclass(format('public.%I', rename_index.new_name)) IS NULL THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', rename_index.old_name, rename_index.new_name);
    END IF;
  END LOOP;
END $$;
