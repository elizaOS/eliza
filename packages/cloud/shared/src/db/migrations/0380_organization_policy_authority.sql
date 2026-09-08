-- Retain policy generations independently of removable override rows.
ALTER TABLE organization_subscription_authorities ADD COLUMN policy_generation bigint NOT NULL DEFAULT 0 CHECK (policy_generation >= 0);
ALTER TABLE org_storage_quota ADD COLUMN limit_override_authorized boolean NOT NULL DEFAULT false;
-- Historical storage rows retain legacy provenance; a number does not prove an approved paid override.
CREATE TABLE organization_policy_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  generation bigint NOT NULL CHECK (generation > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) > 0),
  actor text NOT NULL CHECK (length(btrim(actor)) > 0),
  change jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organization_policy_audit_generation_idx UNIQUE(organization_id, generation)
);

-- New authenticated commands persist their admission scope; historical rows remain unclassified.
ALTER TABLE agent_sandboxes ADD COLUMN quota_admission_scope text NOT NULL DEFAULT 'unclassified' CHECK (quota_admission_scope IN ('organization', 'trusted_internal', 'unclassified'));
