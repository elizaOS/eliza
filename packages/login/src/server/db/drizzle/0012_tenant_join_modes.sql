-- Migration: Add join_mode to tenant_configs
-- Controls how users can join a tenant:
--   'open'   — anyone authenticating with this tenantId gets auto-linked (default, backward compatible)
--   'invite' — user must have an existing user_tenants link (invited by admin)
--   'closed' — no new members allowed at all

ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS join_mode VARCHAR(16) NOT NULL DEFAULT 'open';
