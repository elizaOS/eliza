-- Seed EVM RPC pricing (Alchemy-based with 20% markup)
-- Formula: Alchemy CU cost * $0.00000045 per CU * 1.2 markup
-- Floor: $0.000001 (MIN_RESERVATION for credits system)

INSERT INTO service_pricing (service_id, method, cost, created_at, updated_at)
VALUES
  -- Default pricing (20 CU = $0.000011)
  ('evm-rpc', '_default', '0.000011', NOW(), NOW()),

  -- 0 CU tier (floor at MIN_RESERVATION)
  ('evm-rpc', 'net_version', '0.000001', NOW(), NOW()),
  ('evm-rpc', 'eth_chainId', '0.000001', NOW(), NOW()),
  ('evm-rpc', 'eth_syncing', '0.000001', NOW(), NOW()),
  ('evm-rpc', 'eth_protocolVersion', '0.000001', NOW(), NOW()),
  ('evm-rpc', 'net_listening', '0.000001', NOW(), NOW()),

  -- 10 CU tier ($0.000005)
  ('evm-rpc', 'eth_blockNumber', '0.000005', NOW(), NOW()),
  ('evm-rpc', 'eth_feeHistory', '0.000005', NOW(), NOW()),
  ('evm-rpc', 'eth_maxPriorityFeePerGas', '0.000005', NOW(), NOW()),
  ('evm-rpc', 'eth_blobBaseFee', '0.000005', NOW(), NOW()),
  ('evm-rpc', 'eth_uninstallFilter', '0.000005', NOW(), NOW()),
  ('evm-rpc', 'eth_accounts', '0.000005', NOW(), NOW()),
  ('evm-rpc', 'eth_subscribe', '0.000005', NOW(), NOW()),
  ('evm-rpc', 'eth_unsubscribe', '0.000005', NOW(), NOW()),
  ('evm-rpc', 'eth_createAccessList', '0.000005', NOW(), NOW()),

  -- 20 CU tier ($0.000011)
  ('evm-rpc', 'eth_getBalance', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getBlockByNumber', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getBlockByHash', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getTransactionByHash', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getTransactionReceipt', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_gasPrice', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getCode', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getStorageAt', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_estimateGas', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getTransactionCount', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getBlockTransactionCountByHash', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getBlockTransactionCountByNumber', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getProof', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_newFilter', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_newBlockFilter', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_newPendingTransactionFilter', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getFilterChanges', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'eth_getBlockReceipts', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'web3_clientVersion', '0.000011', NOW(), NOW()),
  ('evm-rpc', 'web3_sha3', '0.000011', NOW(), NOW()),

  -- 26 CU tier ($0.000014)
  ('evm-rpc', 'eth_call', '0.000014', NOW(), NOW()),

  -- 40 CU tier ($0.000022)
  ('evm-rpc', 'eth_sendRawTransaction', '0.000022', NOW(), NOW()),
  ('evm-rpc', 'eth_simulateV1', '0.000022', NOW(), NOW()),

  -- 60 CU tier ($0.000032)
  ('evm-rpc', 'eth_getLogs', '0.000032', NOW(), NOW()),
  ('evm-rpc', 'eth_getFilterLogs', '0.000032', NOW(), NOW())
ON CONFLICT (service_id, method) DO UPDATE SET
  cost = EXCLUDED.cost,
  updated_at = NOW();
