-- #22956: the owner ratified the current storage prices. They are now owned by
-- STORAGE_PRICING in packages/cloud/shared/src/lib/constants/pricing.ts, which
-- every storage charge reads. The service_pricing rows for the storage service
-- stay as a read-only mirror for operator listings; this migration pins them to
-- the catalogue, records any correction in the audit log, and drops the
-- "finalize during pricing review" marker. No historical receipt is touched.
WITH catalogue("method", "cost", "description") AS (
  VALUES
    ('put', 0.0001::numeric(18,12), 'PUT attachment object (per-request charge; per-byte charge layered on top)'),
    ('put_per_byte', 0.000000001::numeric(18,12), 'PUT per-byte charge'),
    ('get', 0.00005::numeric(18,12), 'GET attachment object'),
    ('head', 0.00005::numeric(18,12), 'HEAD attachment metadata'),
    ('list', 0.00005::numeric(18,12), 'List attachment objects under a prefix'),
    ('presign', 0.00005::numeric(18,12), 'Mint a short-lived signed URL'),
    ('delete', 0::numeric(18,12), 'DELETE attachment object (free)')
), corrected AS (
  SELECT pricing.id, pricing.method, pricing.cost AS old_cost, catalogue.cost AS new_cost
  FROM "service_pricing" AS pricing
  JOIN catalogue ON catalogue.method = pricing.method
  WHERE pricing.service_id = 'storage' AND pricing.cost <> catalogue.cost
), audit AS (
  INSERT INTO "service_pricing_audit" (
    service_pricing_id, service_id, method, old_cost, new_cost,
    change_type, changed_by, reason
  )
  SELECT id, 'storage', method, old_cost, new_cost,
    'migration_reseed', 'migration:0503',
    'Pin storage mirror to the ratified STORAGE_PRICING catalogue (#22956)'
  FROM corrected
  RETURNING 1
)
INSERT INTO "service_pricing" ("service_id", "method", "cost", "metadata", "is_active", "updated_by")
SELECT 'storage', catalogue.method, catalogue.cost,
  jsonb_build_object('description', catalogue.description, 'catalogue', 'STORAGE_PRICING'),
  true, 'migration:0503'
FROM catalogue
ON CONFLICT ("service_id", "method") DO UPDATE SET
  "cost" = EXCLUDED."cost",
  "metadata" = EXCLUDED."metadata",
  "is_active" = true,
  "updated_by" = EXCLUDED."updated_by",
  "updated_at" = now();
