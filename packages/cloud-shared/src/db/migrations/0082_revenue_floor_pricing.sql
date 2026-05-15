-- Tighten service pricing floors against current provider pay-per-use rates.
-- Values stored here are raw upstream cost estimates. The X service applies
-- the platform markup at charge time; service_pricing rows for proxy services
-- already include markup in their seeded costs.

INSERT INTO service_pricing (service_id, method, cost, description, metadata, created_at, updated_at)
VALUES
  (
    'x',
    'status',
    '0.010000',
    'X account status/profile check (1 user read)',
    '{"provider": "x-api-pay-per-use", "pricing_basis": "user_read", "raw_provider_cost": 0.01, "markup_applied_in_code": true}'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'x',
    'post',
    '0.015000',
    'Create an X post without media URL',
    '{"provider": "x-api-pay-per-use", "pricing_basis": "content_create", "raw_provider_cost": 0.015, "markup_applied_in_code": true}'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'x',
    'dm.send',
    '0.025000',
    'Send an X direct message plus authenticated-user read',
    '{"provider": "x-api-pay-per-use", "pricing_basis": "dm_create_plus_user_read", "raw_provider_cost": 0.025, "markup_applied_in_code": true}'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'x',
    'dm.digest',
    '0.510000',
    'Read up to 50 X direct message events plus authenticated-user read',
    '{"provider": "x-api-pay-per-use", "pricing_basis": "max_50_dm_event_reads_plus_user_read", "raw_provider_cost": 0.51, "markup_applied_in_code": true}'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'x',
    'dm.curate',
    '0.510000',
    'Curate up to 50 X direct message events plus authenticated-user read',
    '{"provider": "x-api-pay-per-use", "pricing_basis": "max_50_dm_event_reads_plus_user_read", "raw_provider_cost": 0.51, "markup_applied_in_code": true}'::jsonb,
    NOW(),
    NOW()
  ),
  (
    'x',
    'feed.read',
    '0.760000',
    'Read up to 50 X posts and expanded authors plus authenticated-user read',
    '{"provider": "x-api-pay-per-use", "pricing_basis": "max_50_post_reads_50_user_reads_plus_user_read", "raw_provider_cost": 0.76, "markup_applied_in_code": true}'::jsonb,
    NOW(),
    NOW()
  )
ON CONFLICT (service_id, method) DO UPDATE SET
  cost = EXCLUDED.cost,
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata,
  is_active = true,
  updated_at = NOW();
