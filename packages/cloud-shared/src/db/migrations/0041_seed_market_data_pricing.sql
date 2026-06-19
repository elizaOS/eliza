-- Custom SQL migration file, put your code below! --

-- Seed Market Data API Pricing
-- Birdeye CU-based pricing with 20% markup
-- Formula: CU * $0.00001 * 1.2

INSERT INTO "service_pricing" ("service_id", "method", "cost", "metadata")
VALUES
  -- Default fallback (10 CU)
  ('market-data', '_default', 0.000120, '{"cu": 10, "markup": 1.2, "provider": "birdeye"}'),

  -- Token Price (10 CU)
  ('market-data', 'getPrice', 0.000120, '{"cu": 10, "markup": 1.2, "description": "Real-time token price"}'),

  -- Historical Price (60 CU)
  ('market-data', 'getPriceHistorical', 0.000720, '{"cu": 60, "markup": 1.2, "description": "Historical price data"}'),

  -- OHLCV Candles (40 CU)
  ('market-data', 'getOHLCV', 0.000480, '{"cu": 40, "markup": 1.2, "description": "OHLCV candlestick data"}'),

  -- Token Overview (30 CU)
  ('market-data', 'getTokenOverview', 0.000360, '{"cu": 30, "markup": 1.2, "description": "Token overview and metadata"}'),

  -- Token Security (50 CU)
  ('market-data', 'getTokenSecurity', 0.000600, '{"cu": 50, "markup": 1.2, "description": "Token security analysis"}'),

  -- Token Metadata (5 CU)
  ('market-data', 'getTokenMetadata', 0.000060, '{"cu": 5, "markup": 1.2, "description": "Token metadata"}'),

  -- Token Trades (10 CU)
  ('market-data', 'getTokenTrades', 0.000120, '{"cu": 10, "markup": 1.2, "description": "Recent token trades"}'),

  -- Trending Tokens (50 CU)
  ('market-data', 'getTrending', 0.000600, '{"cu": 50, "markup": 1.2, "description": "Trending tokens"}'),

  -- Wallet Portfolio (100 CU)
  ('market-data', 'getWalletPortfolio', 0.001200, '{"cu": 100, "markup": 1.2, "description": "Wallet token portfolio"}'),

  -- Search (50 CU)
  ('market-data', 'search', 0.000600, '{"cu": 50, "markup": 1.2, "description": "Token search"}')
ON CONFLICT (service_id, method) DO UPDATE SET
  "cost" = EXCLUDED."cost",
  "metadata" = EXCLUDED."metadata",
  "updated_at" = now();