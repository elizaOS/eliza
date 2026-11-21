DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'quotes' AND column_name = 'command_id'
  ) THEN
    CREATE INDEX quotes_retained_command_owner_page
      ON quotes (organization_id, created_at DESC, command_id DESC) WHERE command_id IS NOT NULL;
    CREATE VIEW retained_plan_command_history AS
      SELECT command_id, id AS quote_id, organization_id, command_kind AS kind, created_at, state
      FROM quotes WHERE command_id IS NOT NULL;
  ELSE
    CREATE VIEW retained_plan_command_history AS
      SELECT NULL::text AS command_id, NULL::text AS quote_id, NULL::text AS organization_id,
        NULL::text AS kind, NULL::bigint AS created_at, NULL::jsonb AS state WHERE false;
  END IF;
END;
$migration$;
