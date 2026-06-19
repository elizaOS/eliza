/**
 * OAuth — atomic action slice.
 *
 * Re-exports the five atomic OAuth actions, the plugin scaffold, and the
 * runtime contract types (`OAuthIntentsClient`, `OAuthCallbackBusClient`,
 * envelope/result shapes, service name constants).
 */

export {
	awaitOAuthCallbackAction,
	bindOAuthCredentialAction,
	createOAuthIntentAction,
	deliverOAuthLinkAction,
	revokeOAuthCredentialAction,
} from "./actions/index.ts";

export { oauthPlugin, oauthPlugin as default } from "./plugin.ts";
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
	eligibleOAuthDeliveryTargets,
	OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
	OAUTH_INTENTS_CLIENT_SERVICE,
	OAUTH_PROVIDERS,
} from "./types.ts";
