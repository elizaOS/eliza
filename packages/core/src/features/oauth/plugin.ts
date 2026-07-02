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
import type {
	IAgentRuntime,
	Plugin,
	Route,
	Service,
} from "../../types/index.ts";
// Import each action from its defining file, NOT through a re-export-only
// barrel. When the mobile agent bundle lowers @elizaos/core into lazy
// CJS-interop module inits (the core barrel graph is cyclic via
// features/basic-capabilities -> ../index.ts), Bun's tree-shaker drops
// modules that are reachable only through a pure re-export barrel — this
// entire feature was silently absent from the shipped mobile bundle
// (same incident class as sub-agent-credentials/plugin.ts).
import { awaitOAuthCallbackAction } from "./actions/await-oauth-callback.ts";
import { bindOAuthCredentialAction } from "./actions/bind-oauth-credential.ts";
import { createOAuthIntentAction } from "./actions/create-oauth-intent.ts";
import { deliverOAuthLinkAction } from "./actions/deliver-oauth-link.ts";
import { revokeOAuthCredentialAction } from "./actions/revoke-oauth-credential.ts";
import { LocalOAuthCallbackBus } from "./local-callback-bus.ts";
import {
	OAUTH_CALLBACK_BUS_CLIENT_SERVICE,
	OAUTH_PROVIDERS,
	type OAuthCallbackResult,
} from "./types.ts";

type LocalBus = Service & {
	publish?: (result: OAuthCallbackResult) => boolean;
};

const VALID_CALLBACK_STATUS = new Set<OAuthCallbackResult["status"]>([
	"bound",
	"denied",
	"expired",
]);

/**
 * Local OAuth callback delivery route (non-cloud). The OAuth provider's redirect
 * (or a local code-exchange step) POSTs the bind result here keyed by the intent
 * id; we resolve the in-process {@link LocalOAuthCallbackBus} so a waiting
 * AWAIT_OAUTH_CALLBACK returns. `public` because the provider redirect is
 * unauthenticated — the unguessable `oauthIntentId` is the capability token.
 */
export const oauthLocalCallbackRoute: Route = {
	type: "POST",
	path: "/api/oauth/callback",
	name: "oauth-local-callback",
	public: true,
	rawPath: true,
	handler: async (req, res, runtime) => {
		const body = (req.body ?? {}) as Record<string, unknown>;
		const oauthIntentId =
			typeof body.oauthIntentId === "string" ? body.oauthIntentId : "";
		const status = body.status as OAuthCallbackResult["status"];
		if (!oauthIntentId || !VALID_CALLBACK_STATUS.has(status)) {
			res
				.status(400)
				.json({ resolved: false, error: "oauthIntentId and status required" });
			return;
		}
		const provider =
			typeof body.provider === "string" &&
			(OAUTH_PROVIDERS as readonly string[]).includes(body.provider)
				? (body.provider as OAuthCallbackResult["provider"])
				: undefined;
		const bus = runtime.getService<LocalBus>(OAUTH_CALLBACK_BUS_CLIENT_SERVICE);
		if (!bus || typeof bus.publish !== "function") {
			res.status(503).json({
				resolved: false,
				error: "local OAuth callback bus unavailable",
			});
			return;
		}
		const result: OAuthCallbackResult = {
			oauthIntentId,
			provider,
			status,
			connectorIdentityId:
				typeof body.connectorIdentityId === "string"
					? body.connectorIdentityId
					: undefined,
			scopesGranted: Array.isArray(body.scopesGranted)
				? body.scopesGranted.filter((s): s is string => typeof s === "string")
				: undefined,
			error: typeof body.error === "string" ? body.error : undefined,
		};
		const resolved = bus.publish(result);
		res.status(resolved ? 200 : 404).json({ resolved });
	},
};

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
	routes: [oauthLocalCallbackRoute],
	init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
		// Register the in-process callback bus only when no durable (cloud) bus is
		// already present — cloud deployments supply their own cross-process bus.
		if (!runtime.getService(OAUTH_CALLBACK_BUS_CLIENT_SERVICE)) {
			await runtime.registerService(LocalOAuthCallbackBus);
			logger.info(
				"[OAuthPlugin] Initialized with in-process LocalOAuthCallbackBus (no cloud bus present)",
			);
		} else {
			logger.info(
				"[OAuthPlugin] Initialized (using existing OAuthCallbackBus)",
			);
		}
	},
};

export default oauthPlugin;
