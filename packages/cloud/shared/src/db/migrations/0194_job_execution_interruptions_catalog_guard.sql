-- Fail closed if migration 0185 encountered an incompatible same-named
-- column. Migration 0185 is already deployed and immutable; this append-only
-- guard turns its permissive IF NOT EXISTS path into an observable deployment
-- failure before phase-two code can be activated.
DO $$
DECLARE
  catalog_count integer;
  catalog_type text;
  catalog_not_null boolean;
  catalog_default text;
  catalog_generated text;
BEGIN
  SELECT
    count(*)::integer,
    min(format_type(attribute.atttypid, attribute.atttypmod)),
    bool_and(attribute.attnotnull),
    min(pg_get_expr(default_value.adbin, default_value.adrelid)),
    min(attribute.attgenerated)
  INTO catalog_count, catalog_type, catalog_not_null, catalog_default, catalog_generated
  FROM pg_attribute AS attribute
  JOIN pg_class AS relation ON relation.oid = attribute.attrelid
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  LEFT JOIN pg_attrdef AS default_value
    ON default_value.adrelid = attribute.attrelid
    AND default_value.adnum = attribute.attnum
  WHERE namespace.nspname = 'public'
    AND relation.relname = 'jobs'
    AND attribute.attname = 'execution_interruptions'
    AND NOT attribute.attisdropped;

  IF catalog_count <> 1
    OR catalog_type IS DISTINCT FROM 'integer'
    OR catalog_not_null IS DISTINCT FROM true
    OR catalog_default IS DISTINCT FROM '0'
    OR catalog_generated IS DISTINCT FROM ''
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = format(
        'jobs.execution_interruptions catalog mismatch: expected writable integer NOT NULL DEFAULT 0, found count=%s type=%s not_null=%s default=%s generated=%s',
        catalog_count,
        coalesce(catalog_type, 'missing'),
        coalesce(catalog_not_null::text, 'missing'),
        coalesce(catalog_default, 'missing'),
        coalesce(catalog_generated, 'missing')
      );
  END IF;
END
$$;
