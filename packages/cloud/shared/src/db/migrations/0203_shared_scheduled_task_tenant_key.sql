-- Repairs environments that applied the original globally keyed Shared task
-- table before its tenant authority became (agent_id, id).

DO $migration$
DECLARE
  primary_key_name text;
  primary_key_columns text[];
BEGIN
  SELECT constraint_row.conname,
         array_agg(attribute_row.attname ORDER BY key_column.ordinality)
    INTO primary_key_name, primary_key_columns
    FROM pg_constraint AS constraint_row
    JOIN pg_class AS table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace AS namespace_row ON namespace_row.oid = table_row.relnamespace
    CROSS JOIN LATERAL unnest(constraint_row.conkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute AS attribute_row
      ON attribute_row.attrelid = table_row.oid
     AND attribute_row.attnum = key_column.attnum
   WHERE namespace_row.nspname = 'app_scheduling'
     AND table_row.relname = 'life_scheduled_tasks'
     AND constraint_row.contype = 'p'
   GROUP BY constraint_row.conname;

  IF primary_key_columns = ARRAY['agent_id', 'id']::text[] THEN
    RETURN;
  END IF;
  IF primary_key_columns IS DISTINCT FROM ARRAY['id']::text[] THEN
    RAISE EXCEPTION 'Unexpected app_scheduling.life_scheduled_tasks primary key: %',
      primary_key_columns;
  END IF;

  EXECUTE format(
    'ALTER TABLE app_scheduling.life_scheduled_tasks DROP CONSTRAINT %I',
    primary_key_name
  );
  ALTER TABLE app_scheduling.life_scheduled_tasks
    ADD CONSTRAINT life_scheduled_tasks_pkey PRIMARY KEY (agent_id, id);
END
$migration$;
