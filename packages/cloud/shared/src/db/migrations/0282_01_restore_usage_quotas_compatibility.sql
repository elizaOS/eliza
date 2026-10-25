-- 0282_01: restore the historical read shape while the endpoint retires; never reconstruct dropped rows.
CREATE TABLE IF NOT EXISTS "public"."usage_quotas" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"quota_type" text NOT NULL,
	"model_name" text,
	"period_type" text DEFAULT 'weekly' NOT NULL,
	"credits_limit" numeric(10, 2) NOT NULL,
	"current_usage" numeric(10, 2) DEFAULT '0.00' NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "usage_quotas_pkey" PRIMARY KEY ("id"),
	CONSTRAINT "usage_quotas_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id")
		REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.usage_quotas'::regclass
    AND conname='usage_quotas_organization_id_organizations_id_fk') THEN
    ALTER TABLE "public"."usage_quotas" ADD CONSTRAINT
      "usage_quotas_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id")
      REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_quotas_org_id_idx" ON "public"."usage_quotas" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_quotas_quota_type_idx" ON "public"."usage_quotas" USING btree ("quota_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_quotas_period_idx" ON "public"."usage_quotas" USING btree ("period_start", "period_end");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_quotas_active_idx" ON "public"."usage_quotas" USING btree ("is_active");
--> statement-breakpoint
DO $$
DECLARE expected record; actual_type text; actual_not_null boolean; actual_default text; actual_columns name[]; actual_unique boolean; actual_method name; actual_predicate text;
BEGIN
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid='public.usage_quotas'::regclass
    AND attnum > 0 AND NOT attisdropped) <> 12 THEN
    RAISE EXCEPTION 'usage_quotas compatibility column collision'; END IF;
  FOR expected IN SELECT * FROM (VALUES
    (1,'id','uuid',true,'gen_random_uuid()'), (2,'organization_id','uuid',true,NULL),
    (3,'quota_type','text',true,NULL), (4,'model_name','text',false,NULL),
    (5,'period_type','text',true,'''weekly''::text'), (6,'credits_limit','numeric(10,2)',true,NULL),
    (7,'current_usage','numeric(10,2)',true,'0.00'), (8,'period_start','timestamp without time zone',true,NULL),
    (9,'period_end','timestamp without time zone',true,NULL), (10,'is_active','boolean',true,'true'),
    (11,'created_at','timestamp without time zone',true,'now()'), (12,'updated_at','timestamp without time zone',true,'now()')
  ) AS shape(ordinal,column_name,type_name,not_null,default_expr) LOOP
    SELECT format_type(a.atttypid,a.atttypmod), a.attnotnull,
      regexp_replace(lower(pg_get_expr(d.adbin,d.adrelid)), '\s+', '', 'g')
      INTO actual_type, actual_not_null, actual_default
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid='public.usage_quotas'::regclass AND a.attnum=expected.ordinal
        AND a.attname::text=expected.column_name AND NOT a.attisdropped;
    IF actual_type IS DISTINCT FROM expected.type_name OR actual_not_null IS DISTINCT FROM expected.not_null
      OR actual_default IS DISTINCT FROM expected.default_expr THEN
      RAISE EXCEPTION 'usage_quotas compatibility column collision: %', expected.column_name; END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid='public.usage_quotas'::regclass
        AND contype <> 'n') <> 2
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.usage_quotas'::regclass
      AND conname='usage_quotas_pkey' AND contype='p' AND conkey=ARRAY[1]::smallint[] AND convalidated AND NOT condeferrable)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint c
      WHERE c.conrelid='public.usage_quotas'::regclass
        AND c.conname='usage_quotas_organization_id_organizations_id_fk' AND c.contype='f'
        AND c.confrelid='public.organizations'::regclass AND c.confdeltype='c'
        AND c.confupdtype='a' AND c.convalidated AND NOT c.condeferrable
        AND (SELECT array_agg(a.attname ORDER BY key.ordinality) FROM unnest(c.conkey)
          WITH ORDINALITY key(attnum,ordinality) JOIN pg_attribute a
          ON a.attrelid=c.conrelid AND a.attnum=key.attnum)
          = ARRAY['organization_id']::name[]
        AND (SELECT array_agg(a.attname ORDER BY key.ordinality) FROM unnest(c.confkey)
          WITH ORDINALITY key(attnum,ordinality) JOIN pg_attribute a
          ON a.attrelid=c.confrelid AND a.attnum=key.attnum)
          = ARRAY['id']::name[])
  THEN RAISE EXCEPTION 'usage_quotas compatibility constraint collision'; END IF;
  IF (SELECT count(*) FROM pg_index WHERE indrelid='public.usage_quotas'::regclass) <> 5 THEN RAISE EXCEPTION 'usage_quotas compatibility index collision'; END IF;
  FOR expected IN SELECT * FROM (VALUES
    ('usage_quotas_org_id_idx',ARRAY['organization_id']::name[]),
    ('usage_quotas_quota_type_idx',ARRAY['quota_type']::name[]),
    ('usage_quotas_period_idx',ARRAY['period_start','period_end']::name[]),
    ('usage_quotas_active_idx',ARRAY['is_active']::name[])
  ) AS indexes(index_name,column_names) LOOP
    SELECT (SELECT array_agg(a.attname ORDER BY key.ordinality) FROM unnest(i.indkey)
        WITH ORDINALITY key(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=key.attnum),
      i.indisunique, am.amname, pg_get_expr(i.indpred,i.indrelid)
      INTO actual_columns, actual_unique, actual_method, actual_predicate
      FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_am am ON am.oid=c.relam
      WHERE i.indrelid='public.usage_quotas'::regclass AND c.relname=expected.index_name
        AND i.indisvalid AND i.indisready AND i.indexprs IS NULL AND NOT EXISTS (SELECT 1 FROM unnest(i.indoption) option WHERE option <> 0);
    IF actual_columns IS DISTINCT FROM expected.column_names OR actual_unique IS DISTINCT FROM false
      OR actual_method IS DISTINCT FROM 'btree' OR actual_predicate IS NOT NULL
    THEN RAISE EXCEPTION 'usage_quotas compatibility index collision: %', expected.index_name;
    END IF;
  END LOOP;
END $$;
