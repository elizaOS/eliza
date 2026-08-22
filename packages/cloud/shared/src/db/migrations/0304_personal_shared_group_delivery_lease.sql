-- Durable egress lease that orders provider sends before authority revocation.

ALTER TABLE personal_shared_group_bindings
  ADD COLUMN delivery_lease_source_id text,
  ADD COLUMN delivery_lease_token uuid,
  ADD COLUMN delivery_lease_expires_at timestamptz,
  ADD COLUMN delivery_lease_committed_at timestamptz;

COMMENT ON COLUMN personal_shared_group_bindings.delivery_lease_committed_at IS
  'Provider egress linearization marker. Never expire or clear automatically: reconcile the exact source/token against the provider, then persist its exact provider receipt. Until then authority changes must fail closed.';
