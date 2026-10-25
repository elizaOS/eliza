-- #15603 B5: continuous backup restorability verification. Staging ran an
-- ephemeral memory KMS for weeks and every agent backup was permanently
-- undecryptable — nobody noticed until restores failed with "AEAD decrypt
-- failed" (#15310). The provisioning-worker daemon now periodically samples
-- the newest backup per agent, decrypts it with the CURRENT KMS keys, and
-- validates content/manifest hashes. These columns persist the outcome:
--   verification_status  'verified' | 'failed' (NULL = never sampled)
--   verified_at          last verification ATTEMPT — drives the re-verify
--                        sampling interval so the fleet is covered over time
--   verification_error   classified failure (key-unavailable / decrypt-failed /
--                        hash-mismatch / …) for triage without a re-run
ALTER TABLE "agent_sandbox_backups"
  ADD COLUMN IF NOT EXISTS "verification_status" text,
  ADD COLUMN IF NOT EXISTS "verified_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "verification_error" text;
