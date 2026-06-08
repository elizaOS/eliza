-- Detected agent API protocol, probed once during provisioning boot.
-- Used by the bridge to route message.send requests deterministically
-- instead of falling back blindly on every request.
--
-- - 'eliza_bridge': native /bridge JSON-RPC (cloud-agent image).
-- - 'eliza_legacy': /api/conversations REST API (public ghcr.io image).
-- - 'openai_chat': /v1/chat/completions compatibility layer.
-- - 'web_ui_only': no agent API; web UI only.
-- - 'unknown': probe did not run or all probes failed.
--
-- Null on rows provisioned before protocol detection was implemented.
-- The bridge probes on first request for legacy rows and caches the result.
-- See packages/cloud-shared/src/lib/services/eliza-sandbox.ts.

ALTER TABLE "agent_sandboxes"
  ADD COLUMN IF NOT EXISTS "agent_protocol" text;
