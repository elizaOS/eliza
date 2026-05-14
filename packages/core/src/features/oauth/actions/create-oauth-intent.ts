/**
 * CREATE_OAUTH_INTENT — atomic OAuth action.
 *
 * Persists a new OAuth intent via the cloud-backed OAuthIntentsClient and
 * returns the envelope (id, hosted url, scopes, eligible delivery targets).
 * Composes with DELIVER_OAUTH_LINK and AWAIT_OAUTH_CALLBACK to drive the full
 * authorization flow.
 */

import { logger } from "../../../logger.ts";
import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	JsonValue,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	type CreateOAuthIntentInput,
	eligibleOAuthDeliveryTargets,
	OAUTH_INTENTS_CLIENT_SERVICE,
	OAUTH_PROVIDERS,
	type OAuthIntentsClient,
	type OAuthProvider,
} from "../types.ts";

const VALID_PROVIDERS: ReadonlySet<OAuthProvider> = new Set(OAUTH_PROVIDERS);

interface CreateOAuthIntentParams {
	provider?: unknown;
	scopes?: unknown;
	expectedIdentityId?: unknown;
	stateTokenHash?: unknown;
	pkceVerifierHash?: unknown;
	hostedUrl?: unknown;
	callbackUrl?: unknown;
	expiresInMs?: unknown;
	metadata?: unknown;
}

function readParams(
	options: HandlerOptions | Record<string, JsonValue | undefined> | undefined,
): CreateOAuthIntentParams {
	if (!options || typeof options !== "object") return {};
	const params = (options as HandlerOptions).parameters;
	if (params && typeof params === "object") {
		return params as CreateOAuthIntentParams;
	}
	return options as CreateOAuthIntentParams;
}

function buildInput(
	params: CreateOAuthIntentParams,
): { input: CreateOAuthIntentInput } | { error: string } {
	const provider = params.provider;
	if (
		typeof provider !== "string" ||
		!VALID_PROVIDERS.has(provider as OAuthProvider)
	) {
		return { error: "Invalid or missing provider" };
	}
	const scopes = params.scopes;
	if (!Array.isArray(scopes) || !scopes.every((s) => typeof s === "string" && s.length > 0)) {
		return { error: "scopes must be a non-empty string array" };
	}
	const stateTokenHash = params.stateTokenHash;
	if (typeof stateTokenHash !== "string" || stateTokenHash.length < 16) {
		return { error: "stateTokenHash is required (hashed state)" };
	}

	const input: CreateOAuthIntentInput = {
		provider: provider as OAuthProvider,
		scopes: scopes as string[],
		stateTokenHash,
	};

	if (typeof params.expectedIdentityId === "string" && params.expectedIdentityId.length > 0) {
		input.expectedIdentityId = params.expectedIdentityId;
	}
	if (typeof params.pkceVerifierHash === "string" && params.pkceVerifierHash.length > 0) {
		input.pkceVerifierHash = params.pkceVerifierHash;
	}
	if (typeof params.hostedUrl === "string" && params.hostedUrl.length > 0) {
		input.hostedUrl = params.hostedUrl;
	}
	if (typeof params.callbackUrl === "string" && params.callbackUrl.length > 0) {
		input.callbackUrl = params.callbackUrl;
	}
	if (typeof params.expiresInMs === "number" && params.expiresInMs > 0) {
		input.expiresInMs = params.expiresInMs;
	}
	if (
		params.metadata &&
		typeof params.metadata === "object" &&
		!Array.isArray(params.metadata)
	) {
		input.metadata = params.metadata as Record<string, unknown>;
	}
	return { input };
}

export const createOAuthIntentAction: Action = {
	name: "CREATE_OAUTH_INTENT",
	suppressPostActionContinuation: true,
	similes: ["NEW_OAUTH_INTENT", "OPEN_OAUTH_INTENT", "START_OAUTH_FLOW"],
	description:
		"Create a new OAuth intent for a provider (google, discord, linkedin, linear, shopify, calendly).",
	descriptionCompressed: "Create OAuth intent: provider, scopes, stateTokenHash.",
	parameters: [
		{
			name: "provider",
			description: "OAuth provider key.",
			required: true,
			schema: { type: "string" as const, enum: [...OAUTH_PROVIDERS] },
		},
		{
			name: "scopes",
			description: "OAuth scopes to request.",
			required: true,
			schema: { type: "array" as const, items: { type: "string" as const } },
		},
		{
			name: "stateTokenHash",
			description: "Hashed (SHA-256 hex) OAuth state token. Caller hashes the raw state.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "expectedIdentityId",
			description: "Optional connector identity id this intent must bind to.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "pkceVerifierHash",
			description: "Hashed PKCE verifier (optional).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "hostedUrl",
			description: "Provider authorization URL the user should be sent to.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "callbackUrl",
			description: "Callback URL the provider will redirect to after consent.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "expiresInMs",
			description: "Optional TTL override in milliseconds.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "metadata",
			description: "Arbitrary JSON metadata stored alongside the intent.",
			required: false,
			schema: { type: "object" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const built = buildInput(readParams(options));
		return (
			runtime.getService(OAUTH_INTENTS_CLIENT_SERVICE) !== null && "input" in built
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const params = readParams(options);
		const client = runtime.getService(
			OAUTH_INTENTS_CLIENT_SERVICE,
		) as unknown as OAuthIntentsClient | null;
		if (!client) {
			return {
				success: false,
				text: "OAuthIntentsClient not available",
				data: { actionName: "CREATE_OAUTH_INTENT" },
			};
		}
		const built = buildInput(params);
		if ("error" in built) {
			logger.warn(`[CREATE_OAUTH_INTENT] invalid params: ${built.error}`);
			return {
				success: false,
				text: built.error,
				data: { actionName: "CREATE_OAUTH_INTENT" },
			};
		}

		const envelope = await client.create(built.input);
		const eligibleDeliveryTargets = eligibleOAuthDeliveryTargets();

		logger.info(
			`[CREATE_OAUTH_INTENT] oauthIntentId=${envelope.oauthIntentId} provider=${envelope.provider}`,
		);

		const text = `Created OAuth intent ${envelope.oauthIntentId} for ${envelope.provider}.`;
		if (callback) {
			await callback({ text, action: "CREATE_OAUTH_INTENT" });
		}

		return {
			success: true,
			text,
			data: {
				actionName: "CREATE_OAUTH_INTENT",
				oauthIntentId: envelope.oauthIntentId,
				provider: envelope.provider,
				hostedUrl: envelope.hostedUrl,
				expiresAt: envelope.expiresAt,
				scopes: envelope.scopes,
				eligibleDeliveryTargets,
			},
		};
	},

	examples: [],
};
