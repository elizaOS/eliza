-- Paid Plus/Pro entitlements were projected with null resource ceilings, which
-- the quota policy treats as unavailable, so subscribers could not create any
-- resource. The v1 catalog now declares explicit paid ceilings equal to the
-- Free ceilings (the paid-plan floor); republish them onto existing projections
-- so every stored row matches its derivation.
UPDATE "organization_entitlements"
SET
  "cloud_characters_ceiling" = 5,
  "agent_sandboxes_ceiling" = 5,
  "containers_ceiling" = 1,
  "storage_gib_ceiling" = 5,
  "apps_ceiling" = 25,
  "updated_at" = now()
WHERE "billing_scope_id" IS NULL
  AND "plan_key" IN ('plus_monthly', 'pro_monthly')
  AND "catalog_version" = 'v1'
  AND "cloud_characters_ceiling" IS NULL
  AND "agent_sandboxes_ceiling" IS NULL
  AND "containers_ceiling" IS NULL
  AND "storage_gib_ceiling" IS NULL
  AND "apps_ceiling" IS NULL;
