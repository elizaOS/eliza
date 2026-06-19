-- Seed Chain Data (Enhanced) pricing (Alchemy-based with 20% markup)
-- Formula: Alchemy CU cost * $0.00000045 per CU * 1.2 markup
-- Enhanced APIs are 5-100x more expensive than standard RPC

INSERT INTO service_pricing (service_id, method, cost, created_at, updated_at)
VALUES
  -- Default pricing (100 CU = $0.000054)
  ('chain-data', '_default', '0.000054', NOW(), NOW()),

  -- NFT API methods
  ('chain-data', 'getNFTsForOwner', '0.000259', NOW(), NOW()),   -- 480 CU
  ('chain-data', 'getNFTMetadata', '0.000043', NOW(), NOW()),     -- 80 CU

  -- Token API methods
  ('chain-data', 'getTokenBalances', '0.000011', NOW(), NOW()),   -- 20 CU
  ('chain-data', 'getTokenMetadata', '0.000005', NOW(), NOW()),   -- 10 CU

  -- Transfer API methods
  ('chain-data', 'getAssetTransfers', '0.000065', NOW(), NOW())   -- 120 CU
ON CONFLICT (service_id, method) DO UPDATE SET
  cost = EXCLUDED.cost,
  updated_at = NOW();
