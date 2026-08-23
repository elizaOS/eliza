-- Preserve every in-flight committed authorization introduced by migration
-- 0304. Its delivery result is unknown until a provider receipt reconciles it.
INSERT INTO "personal_shared_group_delivery_attempts" (
  "binding_id",
  "platform",
  "project",
  "connector_account_id",
  "provider_chat_id",
  "source_message_id",
  "lease_token",
  "state",
  "committed_at"
)
SELECT
  "id",
  "platform",
  "project",
  "connector_account_id",
  "provider_chat_id",
  "delivery_lease_source_id",
  "delivery_lease_token",
  'committed',
  "delivery_lease_committed_at"
FROM "personal_shared_group_bindings"
WHERE "delivery_lease_source_id" IS NOT NULL
  AND "delivery_lease_token" IS NOT NULL
  AND "delivery_lease_committed_at" IS NOT NULL
ON CONFLICT DO NOTHING;
