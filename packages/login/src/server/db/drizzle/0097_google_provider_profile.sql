-- #203: admit the Google Workspace governed-action canonical profile after
-- #350's 0095 approval pagination and Slack's 0096 profile migration.
--
-- This CHECK is cumulative: it preserves every previously admitted profile
-- while adding only google.provider-action.v1. Unknown profiles remain denied
-- by the storage-layer backstop.
ALTER TABLE "provider_action_bindings" DROP CONSTRAINT "provider_action_bindings_profile_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_profile_chk"
  CHECK ("canonical_profile" IN ('github.provider-action.v1', 'x.provider-action.v1', 'generic-http.provider-action.v1', 'slack.provider-action.v1', 'google.provider-action.v1'));
