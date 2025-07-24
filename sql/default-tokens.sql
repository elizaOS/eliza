insert into "erc20"
	("address", "chain_id", "decimals", "info", "name", "symbol") 
values 
  ('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 1, 6, NULL, 'USD Coin', 'USDC'),
	('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 1, 18, NULL, 'Wrapped Ether', 'WETH'),
  ('0xdAC17F958D2ee523a2206206994597C13D831ec7', 1, 6, '{"allowanceSlot":"0x1720703b80d843ccd5aea9c1af1d6573ad7bb7f405cd9ad961aae73c182d0f0a"}', 'Tether USD', 'USDT');

insert into "erc20" ("address", "chain_id", "decimals", "info", "name", "symbol") values 
  ('0x912CE59144191C1204E64559FE8253a0e49E6548', 42161, 18, NULL, 'Arbitrum', 'ARB'), 
  ('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 42161, 6, NULL, 'USD₮0', 'USDT'), 
  ('0x0c880f6761F1af8d9Aa9C466984b80DAb9a8c9e8', 42161, 18, NULL, 'Pendle', 'PENDLE'), 
  ('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 42161, 6, NULL, 'USD Coin', 'USDC'), 
  ('0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe', 42161, 18, NULL, 'Wrapped eETH', 'weETH'), 
	('0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 42161, 18, NULL, 'Wrapped Ether', 'WETH'),
  ('0xaB7F3837E6e721abBc826927B655180Af6A04388', 42161, 18, '{"swap":{"type":"pendle","market":"0x46d62a8dede1bf2d0de04f2ed863245cbba5e538"}}', 'PT weETH 25JUN2026', 'PT-weETH-25JUN2026'),
  ('0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 42161, 6, NULL, 'USD Coin', 'USDC');