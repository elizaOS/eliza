-- Per-organization attachment-storage quota for the /v1/apis/storage/* proxy.
-- One row per org. Default limit is 5 GiB for free tier; paid tiers update
-- bytes_limit in place. bytes_used is updated atomically on PUT (increment)
-- and DELETE (decrement); writes that would exceed bytes_limit are
-- hard-rejected with 413 by the route handler.

CREATE TABLE IF NOT EXISTS "org_storage_quota" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "bytes_used" bigint NOT NULL DEFAULT 0,
  "bytes_limit" bigint NOT NULL DEFAULT 5368709120,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "org_storage_quota_bytes_used_idx"
  ON "org_storage_quota" ("bytes_used");

-- Pricing entries for the storage proxy. PUT is per-request + per-byte;
-- GET / HEAD / list / presign are flat per-request; DELETE is free.
-- Per-byte pricing for PUT is layered on top via the route handler
-- multiplying by content-length (no DB row needed for that).
INSERT INTO "service_pricing" ("service_id", "method", "cost", "metadata")
VALUES
  ('storage', 'put', 0.0001,
    '{"description": "PUT attachment object (per-request charge; per-byte charge layered on top)"}'::jsonb),
  ('storage', 'get', 0.00005,
    '{"description": "GET attachment object"}'::jsonb),
  ('storage', 'head', 0.00005,
    '{"description": "HEAD attachment metadata"}'::jsonb),
  ('storage', 'list', 0.00005,
    '{"description": "List attachment objects under a prefix"}'::jsonb),
  ('storage', 'presign', 0.00005,
    '{"description": "Mint a short-lived signed URL"}'::jsonb),
  ('storage', 'delete', 0,
    '{"description": "DELETE attachment object (free)"}'::jsonb),
  ('storage', 'put_per_byte', 0.000000001,
    '{"description": "PUT per-byte cost (TODO: finalize during pricing review)"}'::jsonb)
ON CONFLICT ("service_id", "method") DO NOTHING;
