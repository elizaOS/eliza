-- Custom SQL migration file, put your code below! --

INSERT INTO "service_pricing" ("service_id", "method", "cost", "metadata")
VALUES
  ('dexscreener', '_default', 0.000050, '{"description":"DexScreener proxy default"}'),
  ('dexscreener', 'getRequest', 0.000050, '{"description":"DexScreener GET proxy"}')
ON CONFLICT (service_id, method) DO UPDATE SET
  "cost" = EXCLUDED."cost",
  "metadata" = EXCLUDED."metadata",
  "updated_at" = now();
