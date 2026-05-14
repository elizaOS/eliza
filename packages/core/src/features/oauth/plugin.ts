/**
 * OAuth atomic capability slice (Wave C).
 *
 * Registers the five atomic OAuth actions:
 *   CREATE_OAUTH_INTENT, DELIVER_OAUTH_LINK, AWAIT_OAUTH_CALLBACK,
 *   BIND_OAUTH_CREDENTIAL, REVOKE_OAUTH_CREDENTIAL.
 *
 * Composition (create + deliver + await + bind/revoke) lives in the planner.
 * The cloud-backed client implementations (`OAuthIntentsClient`,
 * `OAuthCallbackBusClient`) are registered by sibling Wave C cloud packages
 * and resolved here via `runtime.getService(...)`.
 *
 * This plugin is intentionally NOT auto-enabled. The orchestrator wires it
 * into the default plugin set after parallel waves land; until then it's an
 * opt-in import for callers that need the atomic surface.
 */

import { logger } from "../../logger.ts";
import type { Plugin } from "../../types/index.ts";
import {
	awaitOAuthCallbackAction,
	bindOAuthCredentialAction,
	createOAuthIntentAction,
	deliverOAuthLinkAction,
	revokeOAuthCredentialAction,
} from "./actions/index.ts";

export const oauthPlugin: Plugin = {
	name: "oauth",
	description:
		"Atomic OAuth actions: CREATE_OAUTH_INTENT, DELIVER_OAUTH_LINK, AWAIT_OAUTH_CALLBACK, BIND_OAUTH_CREDENTIAL, REVOKE_OAUTH_CREDENTIAL.",
	actions: [
		createOAuthIntentAction,
		deliverOAuthLinkAction,
		awaitOAuthCallbackAction,
		bindOAuthCredentialAction,
		revokeOAuthCredentialAction,
	],
	init: async () => {
		logger.info("[OAuthPlugin] Initialized");
	},
};

export default oauthPlugin;
