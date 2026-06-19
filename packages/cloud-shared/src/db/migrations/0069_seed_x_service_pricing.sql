-- Seed X API service pricing.
-- These rows unblock the Cloud X relay from startup 503s and let the service
-- debit organization credits before provider access.

INSERT INTO service_pricing (service_id, method, cost, description, metadata, created_at, updated_at)
VALUES
  ('x', 'status', '0.010000', 'X account status/profile check', '{"provider": "twitter-api-v2", "markup": 1.2}'::jsonb, NOW(), NOW()),
  ('x', 'post', '0.050000', 'Create an X post', '{"provider": "twitter-api-v2", "markup": 1.2}'::jsonb, NOW(), NOW()),
  ('x', 'dm.send', '0.050000', 'Send an X direct message', '{"provider": "twitter-api-v2", "markup": 1.2}'::jsonb, NOW(), NOW()),
  ('x', 'dm.digest', '0.030000', 'Read recent X direct messages', '{"provider": "twitter-api-v2", "markup": 1.2}'::jsonb, NOW(), NOW()),
  ('x', 'dm.curate', '0.030000', 'Curate actionable X direct messages', '{"provider": "twitter-api-v2", "markup": 1.2}'::jsonb, NOW(), NOW()),
  ('x', 'feed.read', '0.030000', 'Read X timelines, mentions, and search feeds', '{"provider": "twitter-api-v2", "markup": 1.2}'::jsonb, NOW(), NOW())
ON CONFLICT (service_id, method) DO UPDATE SET
  cost = EXCLUDED.cost,
  description = EXCLUDED.description,
  metadata = EXCLUDED.metadata,
  is_active = true,
  updated_at = NOW();
