CREATE TABLE "organization_entitlements" (
  "organization_id" uuid PRIMARY KEY REFERENCES "organizations"("id") ON DELETE CASCADE,
  "plan_key" text NOT NULL,
  "state" text NOT NULL,
  "effective_from" timestamptz NOT NULL,
  "effective_until" timestamptz,
  "completions_rpm" integer NOT NULL,
  "embeddings_rpm" integer NOT NULL,
  "standard_rpm" integer NOT NULL,
  "strict_rpm" integer NOT NULL,
  "cloud_characters_ceiling" integer NOT NULL,
  "agent_sandboxes_ceiling" integer NOT NULL,
  "containers_ceiling" integer NOT NULL,
  "storage_gib_ceiling" integer NOT NULL,
  "apps_ceiling" integer NOT NULL,
  "catalog_version" text NOT NULL,
  "projection_revision" bigint NOT NULL,
  "source_digest" text NOT NULL,
  "source_subscription_id" uuid,
  "source_subscription_revision" bigint,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "rebuilt_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "organization_entitlements_subscription_tenant_fk" FOREIGN KEY (source_subscription_id, organization_id) REFERENCES billing_subscriptions(id, organization_id) ON DELETE RESTRICT,
  CONSTRAINT "organization_entitlements_source_revision_tenant_fk" FOREIGN KEY (source_subscription_id, organization_id, source_subscription_revision) REFERENCES billing_subscription_revisions(subscription_id, organization_id, revision) ON DELETE RESTRICT,
  CONSTRAINT "organization_entitlements_plan_state_check" CHECK (plan_key IN ('free','plus_monthly','pro_monthly') AND state IN ('free','active','grace','past_due','unpaid') AND ((plan_key = 'free' AND state = 'free' AND source_subscription_id IS NULL AND source_subscription_revision IS NULL) OR (plan_key <> 'free' AND state <> 'free' AND source_subscription_id IS NOT NULL AND source_subscription_revision IS NOT NULL))),
  CONSTRAINT "organization_entitlements_effective_bounds_check" CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT "organization_entitlements_rates_check" CHECK (completions_rpm >= 0 AND embeddings_rpm >= 0 AND standard_rpm >= 0 AND strict_rpm >= 0),
  CONSTRAINT "organization_entitlements_ceilings_check" CHECK (cloud_characters_ceiling >= 0 AND agent_sandboxes_ceiling >= 0 AND containers_ceiling >= 0 AND storage_gib_ceiling >= 0 AND apps_ceiling >= 0),
  CONSTRAINT "organization_entitlements_revisions_check" CHECK (projection_revision >= 0 AND (source_subscription_revision IS NULL OR source_subscription_revision > 0)),
  CONSTRAINT "organization_entitlements_catalog_version_check" CHECK (length(btrim(catalog_version)) > 0),
  CONSTRAINT "organization_entitlements_source_digest_check" CHECK (source_digest ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
-- SHA-256 preimage: free:v1:60:100:30:5:5:5:1:5:25
INSERT INTO "organization_entitlements" (organization_id, plan_key, state, effective_from, completions_rpm, embeddings_rpm, standard_rpm, strict_rpm, cloud_characters_ceiling, agent_sandboxes_ceiling, containers_ceiling, storage_gib_ceiling, apps_ceiling, catalog_version, projection_revision, source_digest)
SELECT id, 'free', 'free', now(), 60, 100, 30, 5, 5, 5, 1, 5, 25, 'v1', 0, '79e8741542b6d430565b42253cb5afe09619c8e5764c545d4d19cab68fd1304b' FROM organizations;
--> statement-breakpoint
CREATE FUNCTION "seed_free_organization_entitlement"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO organization_entitlements (organization_id, plan_key, state, effective_from, completions_rpm, embeddings_rpm, standard_rpm, strict_rpm, cloud_characters_ceiling, agent_sandboxes_ceiling, containers_ceiling, storage_gib_ceiling, apps_ceiling, catalog_version, projection_revision, source_digest)
  VALUES (NEW.id, 'free', 'free', now(), 60, 100, 30, 5, 5, 5, 1, 5, 25, 'v1', 0, '79e8741542b6d430565b42253cb5afe09619c8e5764c545d4d19cab68fd1304b');
  RETURN NEW;
END $$;
CREATE TRIGGER "organizations_seed_free_entitlement" AFTER INSERT ON "organizations" FOR EACH ROW EXECUTE FUNCTION "seed_free_organization_entitlement"();
