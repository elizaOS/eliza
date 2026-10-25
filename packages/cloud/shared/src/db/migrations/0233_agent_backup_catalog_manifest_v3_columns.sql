-- Persist manifest-v3's atomic operation-key envelope and authenticated vault pointer.
-- Vault authority tables arrive with restore; these scalar receipt fields fail closed today.

ALTER TABLE "agent_sandbox_backups"
  ADD COLUMN IF NOT EXISTS "operation_key_bundle_generation_id" uuid,
  ADD COLUMN IF NOT EXISTS "operation_key_bundle_format" text,
  ADD COLUMN IF NOT EXISTS "operation_key_bundle_ref" text,
  ADD COLUMN IF NOT EXISTS "operation_key_bundle_ciphertext_base64" text,
  ADD COLUMN IF NOT EXISTS "operation_key_bundle_sha256" text,
  ADD COLUMN IF NOT EXISTS "operation_key_bundle_size_bytes" integer,
  ADD COLUMN IF NOT EXISTS "operation_key_bundle_context" text,
  ADD COLUMN IF NOT EXISTS "operation_key_bundle_context_derivation" text,
  ADD COLUMN IF NOT EXISTS "operation_key_bundle_local_receipt_derivation" text,
  ADD COLUMN IF NOT EXISTS "operation_key_bundle_local_receipt_digest" text,
  ADD COLUMN IF NOT EXISTS "vault_key_generation_id" uuid,
  ADD COLUMN IF NOT EXISTS "vault_key_authority_receipt_digest" text;
