-- Additive authority for independently authenticated principals in Personal Shared groups.
-- Existing bindings remain byte-compatible through the single_owner / one-principal defaults.

ALTER TABLE personal_shared_group_claims
  ADD COLUMN consent_mode text NOT NULL DEFAULT 'single_owner',
  ADD COLUMN required_principal_count integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT personal_shared_group_claims_consent_config_check CHECK (
    (consent_mode = 'single_owner' AND required_principal_count = 1)
    OR (consent_mode = 'all_adults' AND required_principal_count BETWEEN 2 AND 32)
  );

ALTER TABLE personal_shared_group_bindings
  ADD COLUMN consent_mode text NOT NULL DEFAULT 'single_owner',
  ADD COLUMN required_principal_count integer NOT NULL DEFAULT 1,
  ADD COLUMN consent_version bigint NOT NULL DEFAULT 1,
  ADD CONSTRAINT personal_shared_group_bindings_consent_config_check CHECK (
    (consent_mode = 'single_owner' AND required_principal_count = 1)
    OR (consent_mode = 'all_adults' AND required_principal_count BETWEEN 2 AND 32)
  );

ALTER TABLE personal_shared_group_participants
  ADD COLUMN linked_user_id uuid REFERENCES users(id),
  ADD COLUMN consented_at timestamptz,
  ADD COLUMN consent_provenance text,
  ADD COLUMN revoked_at timestamptz,
  ADD CONSTRAINT personal_shared_group_participants_consent_provenance_check CHECK (
    consent_provenance IS NULL
    OR consent_provenance IN ('owner_binding', 'authenticated_dm')
  ),
  ADD CONSTRAINT personal_shared_group_participants_consent_shape_check CHECK (
    (linked_user_id IS NULL AND consented_at IS NULL AND consent_provenance IS NULL)
    OR (
      linked_user_id IS NOT NULL
      AND consented_at IS NOT NULL
      AND consent_provenance IS NOT NULL
      AND revoked_at IS NULL
    )
  );

CREATE UNIQUE INDEX personal_shared_group_participants_linked_user_uidx
  ON personal_shared_group_participants (binding_id, linked_user_id);
CREATE INDEX personal_shared_group_participants_linked_user_idx
  ON personal_shared_group_participants (linked_user_id);

CREATE TABLE personal_shared_group_join_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  stage text NOT NULL CHECK (stage IN ('authenticate', 'confirm')),
  binding_id uuid NOT NULL REFERENCES personal_shared_group_bindings(id) ON DELETE CASCADE,
  consent_version bigint NOT NULL,
  platform text NOT NULL CHECK (platform IN ('telegram', 'blooio')),
  project text NOT NULL,
  connector_account_id text NOT NULL,
  provider_chat_id text NOT NULL,
  provider_thread_id text NOT NULL DEFAULT '',
  issued_to_platform_user_id text NOT NULL,
  source_message_id text NOT NULL,
  linked_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  consumed_by_source_message_id text,
  superseded_at timestamptz,
  superseded_by_source_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_shared_group_join_challenges_linked_user_stage_check CHECK (
    (stage = 'authenticate' AND linked_user_id IS NULL)
    OR (stage = 'confirm' AND linked_user_id IS NOT NULL)
  ),
  CONSTRAINT personal_shared_group_join_challenges_superseded_source_check CHECK (
    (superseded_at IS NULL) = (superseded_by_source_message_id IS NULL)
  )
);

CREATE INDEX personal_shared_group_join_challenges_binding_stage_idx
  ON personal_shared_group_join_challenges (binding_id, stage);
CREATE INDEX personal_shared_group_join_challenges_expires_idx
  ON personal_shared_group_join_challenges (expires_at);
CREATE INDEX personal_shared_group_join_challenges_linked_user_idx
  ON personal_shared_group_join_challenges (linked_user_id);
CREATE UNIQUE INDEX personal_shared_group_join_challenges_source_uidx
  ON personal_shared_group_join_challenges
  (binding_id, stage, issued_to_platform_user_id, source_message_id);
