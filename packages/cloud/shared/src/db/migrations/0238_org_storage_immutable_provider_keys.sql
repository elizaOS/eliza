ALTER TABLE "org_storage_objects"
  ADD COLUMN IF NOT EXISTS "current_provider_key" text;
ALTER TABLE "org_storage_operations"
  ADD COLUMN IF NOT EXISTS "source_provider_key" text,
  ADD COLUMN IF NOT EXISTS "target_provider_key" text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'org_storage_objects_provider_key_shape_check'
      AND conrelid = 'org_storage_objects'::regclass) THEN
    ALTER TABLE "org_storage_objects" ADD CONSTRAINT "org_storage_objects_provider_key_shape_check"
    CHECK ((
      ("presence" = 'absent' AND "current_provider_key" IS NULL)
      OR ("presence" = 'present' AND "current_provider_key" IS NOT NULL
        AND octet_length("current_provider_key") <= 1024
        AND "current_provider_key" IS NFC NORMALIZED
        AND ("current_provider_key" = '__eliza_storage_authority/v1/org/'
          || "organization_id"::text || '/' || "id"::text || '/' || "committed_generation"::text
          OR ("committed_generation" = 1 AND "current_provider_key" = "object_key")))
    ) IS TRUE);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'org_storage_operations_provider_key_shape_check'
      AND conrelid = 'org_storage_operations'::regclass) THEN
    ALTER TABLE "org_storage_operations"
      ADD CONSTRAINT "org_storage_operations_provider_key_shape_check" CHECK ((
      (("source_presence" = 'absent' AND "source_provider_key" IS NULL)
        OR ("source_presence" = 'present' AND "source_provider_key" IS NOT NULL
          AND octet_length("source_provider_key") <= 1024
          AND "source_provider_key" IS NFC NORMALIZED
          AND ("source_provider_key" = '__eliza_storage_authority/v1/org/'
            || "organization_id"::text || '/' || "object_id"::text || '/' || "source_generation"::text
            OR ("source_generation" = 1
              AND "source_provider_key" LIKE 'org/' || "organization_id"::text || '/%'
              AND char_length("source_provider_key")
                > char_length('org/' || "organization_id"::text || '/')
              AND "source_provider_key" !~ '[[:cntrl:]]'
              AND "source_provider_key" !~ '(^|/)\.\.(/|$)')))
      ) AND (("operation" = 'put' AND "target_provider_key" IS NOT NULL
          AND octet_length("target_provider_key") <= 1024
          AND "target_provider_key" IS NFC NORMALIZED
          AND "target_provider_key" = '__eliza_storage_authority/v1/org/'
            || "organization_id"::text || '/' || "object_id"::text || '/' || "target_generation"::text)
        OR ("operation" = 'delete' AND "target_provider_key" IS NULL))
      AND ("source_provider_key" IS NULL OR "target_provider_key" IS NULL
        OR "source_provider_key" <> "target_provider_key")
    ) IS TRUE);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'org_storage_operations_observation_shape_check'
      AND conrelid = 'org_storage_operations'::regclass) THEN
    ALTER TABLE "org_storage_operations"
      ADD CONSTRAINT "org_storage_operations_observation_shape_check" CHECK ((
      ("last_observed_at" IS NULL OR ("provider_started_at" IS NOT NULL
        AND "last_observed_at" >= "provider_started_at"))
      AND ("state" <> 'committed' OR "source_presence" <> 'present'
        OR "last_observed_at" IS NOT NULL)
      AND ("state" <> 'quarantined' OR "last_observed_at" IS NOT NULL)
      AND ("state" <> 'aborted' OR "last_observed_at" IS NULL)
    ) IS TRUE);
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "org_storage_objects_current_provider_key_uidx"
  ON "org_storage_objects" ("current_provider_key") WHERE "current_provider_key" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "org_storage_operations_target_provider_key_uidx"
  ON "org_storage_operations" ("target_provider_key") WHERE "target_provider_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "org_storage_operations_source_provider_key_idx"
  ON "org_storage_operations" ("source_provider_key") WHERE "source_provider_key" IS NOT NULL;
