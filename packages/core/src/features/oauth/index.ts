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

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name. Without this eager anchor
// the whole feature is reachable only through re-export edges and Bun.build
// tree-shakes the module bodies out of the mobile agent bundle (see
// features/payments/index.ts — same incident class). The plugin eagerly
// imports every action, so anchoring it keeps the full feature.
import { anchorBundleSafety } from "../../bundle-safety.ts";
import { oauthPlugin as _bs_1_oauthPlugin } from "./plugin.ts";

anchorBundleSafety("FEATURES_OAUTH_INDEX", [_bs_1_oauthPlugin]);
