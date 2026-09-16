-- Makes pre-cutover source rows explicitly visible to frozen admission scans.

CREATE OR REPLACE FUNCTION "agent_backup_admission_source_visible"(
  source_xid xid8,
  frozen_snapshot pg_snapshot
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN source_xid = '0'::xid8 THEN TRUE
    ELSE pg_visible_in_snapshot(source_xid, frozen_snapshot)
  END
$$;
