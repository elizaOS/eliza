-- #202: adapter-fixed Slack provider profile (slack.provider-action.v1).
--
-- The provider-action binding table uses this named CHECK as its storage-layer
-- backstop. Keep the allowlist cumulative while admitting Slack bindings
-- produced by the registered production adapter.
ALTER TABLE "provider_action_bindings" DROP CONSTRAINT "provider_action_bindings_profile_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_profile_chk"
  CHECK ("canonical_profile" IN ('github.provider-action.v1', 'x.provider-action.v1', 'generic-http.provider-action.v1', 'slack.provider-action.v1'));
