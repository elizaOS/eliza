-- Wave C: persistent identity-link store.
-- Backs SensitiveRequestIdentityAuthorizationAdapter.areEntitiesLinked so the
-- authorization layer can recognize that two entity ids represent the same
-- person (e.g. a Discord identity and the owner cloud user). Replaces the
-- in-memory stub used by the default adapter.

CREATE TABLE IF NOT EXISTS identity_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  left_entity_id TEXT NOT NULL,
  right_entity_id TEXT NOT NULL,
  provider TEXT,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('oauth','manual','wallet')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_identity_links_unique_pair
  ON identity_links(left_entity_id, right_entity_id, provider);
CREATE INDEX idx_identity_links_left ON identity_links(left_entity_id);
CREATE INDEX idx_identity_links_right ON identity_links(right_entity_id);
CREATE INDEX idx_identity_links_org_user ON identity_links(organization_id, user_id);
