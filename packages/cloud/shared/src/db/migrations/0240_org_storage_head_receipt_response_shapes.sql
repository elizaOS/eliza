DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'org_storage_head_receipts_response_value_check'
      AND conrelid = 'org_storage_head_receipts'::regclass) THEN
    ALTER TABLE "org_storage_head_receipts" ADD CONSTRAINT
      "org_storage_head_receipts_response_value_check" CHECK ((
        ("object_generation" IS NULL OR "object_generation" > 0)
        AND ("response_content_length" IS NULL OR
          "response_content_length" BETWEEN 0 AND 9007199254740991)
        AND ("response_content_type" IS NULL OR (
          char_length("response_content_type") BETWEEN 1 AND 255
          AND "response_content_type" COLLATE "C" !~ U&'^[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]|[\0009-\000D\0020\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]$'
          AND "response_content_type" COLLATE "C" !~ U&'[\0001-\001F\007F-\009F]'))
        AND ("response_etag" IS NULL OR (
          char_length("response_etag") BETWEEN 1 AND 512
          AND "response_etag" ~ '^[!#-~]+$'))
        AND ("response_last_modified" IS NULL OR (
          isfinite("response_last_modified")
          AND "response_last_modified" = date_trunc('second', "response_last_modified")))
      ) IS TRUE);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname = 'org_storage_head_receipts_response_shape_check'
      AND conrelid = 'org_storage_head_receipts'::regclass) THEN
    ALTER TABLE "org_storage_head_receipts" ADD CONSTRAINT
      "org_storage_head_receipts_response_shape_check" CHECK ((
        ("response_kind" = 'ok' AND "response_status" = 200 AND num_nulls(
          "object_id", "object_generation", "response_content_length", "response_content_type",
          "response_etag", "response_last_modified", "response_force_attachment") = 0)
        OR ("response_kind" = 'not_modified' AND "response_status" = 304
          AND num_nulls("object_id", "object_generation", "response_etag",
            "response_last_modified") = 0
          AND num_nonnulls("response_content_length", "response_content_type",
            "response_force_attachment") = 0)
        OR ("response_kind" = 'not_found' AND "response_status" = 404
          AND num_nonnulls("object_id", "object_generation", "response_content_length",
            "response_content_type", "response_etag", "response_last_modified",
            "response_force_attachment") = 0)
        OR ("response_kind" = 'precondition_failed' AND "response_status" = 412
          AND num_nulls("object_id", "object_generation", "response_etag",
            "response_last_modified") = 0
          AND num_nonnulls("response_content_length", "response_content_type",
            "response_force_attachment") = 0)
      ) IS TRUE);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION "reject_org_storage_head_receipt_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'org_storage_head_receipts_immutable'
    USING ERRCODE = '23514',
      CONSTRAINT = 'org_storage_head_receipts_immutable';
END;
$$;
DROP TRIGGER IF EXISTS "org_storage_head_receipts_immutable_trigger"
  ON "org_storage_head_receipts";
CREATE TRIGGER "org_storage_head_receipts_immutable_trigger"
  AFTER UPDATE ON "org_storage_head_receipts"
  FOR EACH ROW EXECUTE FUNCTION "reject_org_storage_head_receipt_update"();
