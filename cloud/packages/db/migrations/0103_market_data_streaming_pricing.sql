-- Custom SQL migration file, put your code below! --

-- Additional Birdeye paths used by @elizaos/plugin-birdeye (cloud proxy allowlist).
INSERT INTO "service_pricing" ("service_id", "method", "cost", "metadata")
VALUES
  ('market-data', 'getTokenMarketDataV3', 0.000360, '{"description":"Birdeye v3 token market-data"}'),
  ('market-data', 'getPriceVolumeSingle', 0.000120, '{"description":"Birdeye price_volume single"}'),
  ('market-data', 'getTokenTradeDataSingle', 0.000120, '{"description":"Birdeye v3 trade-data single"}'),
  ('market-data', 'getMultiPrice', 0.000600, '{"description":"Birdeye multi_price batch"}'),
  ('market-data', 'getWalletTxList', 0.001200, '{"description":"Birdeye wallet tx list"}'),
  ('streaming', '_default', 0.010000, '{"description":"Streaming proxy default"}'),
  ('streaming', 'session.create', 0.010000, '{"description":"RTMP relay session create (stub)"}')
ON CONFLICT (service_id, method) DO UPDATE SET
  "cost" = EXCLUDED."cost",
  "metadata" = EXCLUDED."metadata",
  "updated_at" = now();
