-- #201: config-driven generic-http provider profile (generic-http.provider-action.v1).
--
-- The provider-action pipeline is otherwise adapter-agnostic: the ONLY schema
-- gate on a new canonical profile is the `provider_action_bindings_profile_chk`
-- allowlist CHECK. 0080 hardcoded the github literal; 0082 widened it to an
-- IN-list admitting the X profile. This migration widens that SAME named CHECK
-- to additionally admit the generic-http profile so an operator-authored
-- governed HTTP operation can persist a binding through the identical pipeline
-- (access -> policy -> approval -> execution -> evidence) as github/x.
--
-- Widening an IN-list is a pure additive relaxation: no existing github/x row
-- can violate it, and an UNKNOWN profile is still rejected by the same CHECK
-- (the code-side profile registry rejects it earlier, fail-closed, at every
-- consumption site; this CHECK is the storage-layer backstop). The generic-http
-- operation descriptor itself is operator config stored in the existing
-- `provider_operations.request_profile` JSONB (validated in-app with a strict
-- descriptor validator); it needs no new column.
ALTER TABLE "provider_action_bindings" DROP CONSTRAINT "provider_action_bindings_profile_chk";
--> statement-breakpoint
ALTER TABLE "provider_action_bindings" ADD CONSTRAINT "provider_action_bindings_profile_chk"
  CHECK ("canonical_profile" IN ('github.provider-action.v1', 'x.provider-action.v1', 'generic-http.provider-action.v1'));
