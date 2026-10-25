-- Migration: Add Organization Encryption Keys
-- Date: 2026-01-22
-- Purpose: Create table for storing per-organization Data Encryption Keys (DEKs)
--          to support field-level encryption for sensitive data

-- Create organization encryption keys table for per-org field encryption
CREATE TABLE IF NOT EXISTS "organization_encryption_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "encrypted_dek" text NOT NULL,
  "key_version" integer NOT NULL DEFAULT 1,
  "algorithm" text NOT NULL DEFAULT 'aes-256-gcm',
  "created_at" timestamp NOT NULL DEFAULT now(),
  "rotated_at" timestamp,
  CONSTRAINT "organization_encryption_keys_org_unique" UNIQUE ("organization_id")
);

-- Index for efficient lookups by organization
CREATE INDEX IF NOT EXISTS "org_encryption_keys_org_idx"
  ON "organization_encryption_keys"("organization_id");

-- Documentation
COMMENT ON TABLE organization_encryption_keys IS 'Stores wrapped DEKs for per-organization field encryption';
COMMENT ON COLUMN organization_encryption_keys.encrypted_dek IS 'DEK encrypted with master key. Format: <nonce>:<authTag>:<encryptedDek> (all base64)';
COMMENT ON COLUMN organization_encryption_keys.key_version IS 'Incremented on key rotation';
COMMENT ON COLUMN organization_encryption_keys.algorithm IS 'Encryption algorithm (aes-256-gcm)';
COMMENT ON COLUMN organization_encryption_keys.rotated_at IS 'Timestamp of last key rotation';
