-- Add "allowed-chains" to the policy_type enum.
-- Uses IF NOT EXISTS so the migration is idempotent (safe to re-run).
ALTER TYPE "policy_type" ADD VALUE IF NOT EXISTS 'allowed-chains';
