/**
 * OAuth — atomic action slice.
 *
 * Re-exports the five atomic OAuth actions, the plugin scaffold, and the
 * runtime contract types (`OAuthIntentsClient`, `OAuthCallbackBusClient`,
 * envelope/result shapes, service name constants).
 */

// Re-export each action from its defining file, NOT through a re-export-only
// barrel — see the note in ./plugin.ts (Bun.build drops barrel-only-reachable
// modules when the mobile bundle lowers @elizaos/core to lazy CJS-interop
// inits, silently removing the feature from the on-device bundle).
export { awaitOAuthCallbackAction } from "./actions/await-oauth-callback.ts";
export { bindOAuthCredentialAction } from "./actions/bind-oauth-credential.ts";
export { createOAuthIntentAction } from "./actions/create-oauth-intent.ts";
export { deliverOAuthLinkAction } from "./actions/deliver-oauth-link.ts";
export { revokeOAuthCredentialAction } from "./actions/revoke-oauth-credential.ts";

export { LocalOAuthCallbackBus } from "./local-callback-bus.ts";
export {
  oauthLocalCallbackRoute,
  oauthPlugin,
  oauthPlugin as default,
} from "./plugin.ts";
export type {
  CreateOAuthIntentInput,
  OAuthBindResult,
  OAuthCallbackBusClient,
  OAuthCallbackResult,
  OAuthIntentEnvelope,
  OAuthIntentStatus,
  OAuthIntentsClient,
  OAuthProvider,
  OAuthRevokeResult,
} from "./types.ts";
export {
  CONNECTOR_NATIVE_OAUTH_PROVIDERS,
  eligibleOAuthDeliveryTargets,
  OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
  OAUTH_INTENTS_CLIENT_SERVICE,
  OAUTH_PROVIDERS,
} from "./types.ts";
