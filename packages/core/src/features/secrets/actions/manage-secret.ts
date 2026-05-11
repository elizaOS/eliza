/**
 * SECRETS Action
 *
 * Single umbrella action for all secret management. The planner picks
 * `SECRETS` and supplies a structured `action` value (`get | set | delete |
 * list | check | mirror | request`); the dispatcher routes to the
 * appropriate atomic handler. Legacy discriminator names (`subaction`, `op`,
 * `operation`) remain accepted on input for back-compat.
 *
 * `SECRETS_UPDATE_SETTINGS` stays a separate action (it's a settings
 * mutation, not a secret operation).
 */

import { logger } from "../../../logger.ts";
import {
	type Action,
	type ActionExample,
	ChannelType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	type State,
} from "../../../types/index.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../services/secrets.ts";
import { checkSecretHandler } from "./check-secret.ts";
import { deleteSecretHandler } from "./delete-secret.ts";
import { getSecretHandler } from "./get-secret.ts";
import { listSecretsHandler } from "./list-secrets.ts";
import { mirrorSecretToVaultHandler } from "./mirror-secret-to-vault.ts";
import { requestSecretHandler } from "./request-secret.ts";
import { setSecretHandler } from "./set-secret.ts";

type SecretsAction =
	| "get"
	| "set"
	| "delete"
	| "list"
	| "check"
	| "mirror"
	| "request";

const SECRETS_ACTIONS: readonly SecretsAction[] = [
	"get",
	"set",
	"delete",
	"list",
	"check",
	"mirror",
	"request",
] as const;

/**
 * Resolve the requested subaction from structured parameters, honouring the
 * canonical `action` key and legacy aliases (`subaction`, `op`, `operation`).
 */
function resolveSecretsAction(
	params: Record<string, unknown>,
): SecretsAction | undefined {
	const candidates = [params.action, params.subaction, params.op, params.operation];
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const normalized = candidate.trim().toLowerCase();
		if (SECRETS_ACTIONS.includes(normalized as SecretsAction)) {
			return normalized as SecretsAction;
		}
	}
	return undefined;
}

/**
 * Dispatch table mapping resolved actions to their atomic handlers. Every
 * handler returns the same ActionResult shape, so callers can rely on
 * `data.actionName === "SECRETS"` and `data.action === <subaction>`.
 */
const dispatch: Record<
	SecretsAction,
	(
		runtime: IAgentRuntime,
		message: Memory,
		state: State | undefined,
		options: HandlerOptions | undefined,
		callback: HandlerCallback | undefined,
	) => Promise<{
		success: boolean;
		text: string;
		data: Record<string, unknown>;
		error?: string;
	}>
> = {
	get: getSecretHandler,
	set: setSecretHandler,
	delete: deleteSecretHandler,
	list: listSecretsHandler,
	check: checkSecretHandler,
	mirror: mirrorSecretToVaultHandler,
	request: requestSecretHandler,
};

/**
 * SECRETS — single umbrella action for all secret management.
 */
export const secretsAction: Action = {
	name: "SECRETS",
	contexts: ["secrets", "settings", "connectors"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	similes: [
		"SECRET_MANAGEMENT",
		"HANDLE_SECRET",
		"SECRET_OPERATION",
		"STORE_SECRET",
		"SAVE_SECRET",
		"CONFIGURE_SECRET",
		"SET_API_KEY",
		"READ_SECRET",
		"FETCH_SECRET",
		"RETRIEVE_SECRET",
		"HAS_SECRET",
		"VERIFY_SECRET",
		"SECRET_EXISTS",
		"REMOVE_SECRET",
		"ERASE_SECRET",
		"PURGE_SECRET",
		"ENUMERATE_SECRETS",
		"SHOW_SECRETS",
		"COPY_SECRET_TO_VAULT",
		"VAULT_MIRROR_SECRET",
		"ASK_FOR_SECRET",
		"REQUIRE_SECRET",
		"NEED_SECRET",
		"MISSING_SECRET",
	],
	description:
		"Manage secrets — get, set, delete, list, check, mirror to a vault, or request a missing secret.",
	parameters: [
		{
			name: "action",
			description:
				"Secret operation: get, set, delete, list, check, mirror, or request.",
			required: true,
			schema: {
				type: "string" as const,
				enum: [
					"get",
					"set",
					"delete",
					"list",
					"check",
					"mirror",
					"request",
				],
			},
		},
		{
			name: "key",
			description:
				"Secret key (string), array of keys (for check), or omitted (for list).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "value",
			description: "Secret value when setting a secret.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "level",
			description: "Storage level.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["global", "world", "user"],
			},
		},
		{
			name: "mask",
			description:
				"When true, mask the returned value for display (action=get).",
			required: false,
			schema: { type: "boolean" as const },
		},
		{
			name: "prefix",
			description:
				"Optional key prefix filter for action=list (case-insensitive).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "description",
			description: "Optional short description for the secret (action=set).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "type",
			description: "Secret type (action=set).",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["api_key", "secret", "credential", "url", "config"],
			},
		},
		{
			name: "secrets",
			description:
				"Array of secrets to store (action=set). Each entry has key and value.",
			required: false,
			schema: {
				type: "array" as const,
				items: {
					type: "object" as const,
					properties: {
						key: { type: "string" as const },
						value: { type: "string" as const },
						description: { type: "string" as const },
						type: {
							type: "string" as const,
							enum: ["api_key", "secret", "credential", "url", "config"],
						},
					},
					required: ["key", "value"],
				},
			},
		},
		{
			name: "vaultName",
			description: "Service name of the vault to mirror into (action=mirror).",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "reason",
			description: "Why the secret is needed (action=request).",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE) === null) {
			return false;
		}

		const params =
			options?.parameters && typeof options.parameters === "object"
				? (options.parameters as Record<string, unknown>)
				: {};
		const resolved = resolveSecretsAction(params);

		// `request` validates in any channel (it routes the user to the right
		// surface). Every other subaction is DM-only because the model may
		// echo secret values into the chat.
		if (resolved !== "request") {
			const channelType = message.content.channelType;
			if (channelType !== undefined && channelType !== ChannelType.DM) {
				return false;
			}
		}

		const hasStructuredAction = typeof resolved === "string";
		const hasStructuredKey =
			typeof params.key === "string" && params.key.trim().length > 0;
		const hasStructuredSecrets =
			Array.isArray(params.secrets) && params.secrets.length > 0;

		return (
			hasStructuredAction ||
			hasStructuredKey ||
			hasStructuredSecrets ||
			hasActionContext(message, state, {
				contexts: ["secrets", "settings", "connectors"],
			})
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const params =
			options?.parameters && typeof options.parameters === "object"
				? (options.parameters as Record<string, unknown>)
				: {};

		const resolved = resolveSecretsAction(params);
		if (!resolved) {
			logger.warn(
				"[SECRETS] Missing or unknown action; expected one of: get, set, delete, list, check, mirror, request",
			);
			const text =
				"I'm not sure what secret operation you want. Choose get, set, delete, list, check, mirror, or request.";
			if (callback) {
				await callback({ text, action: "SECRETS" });
			}
			return {
				success: false,
				text,
				data: { actionName: "SECRETS", action: null },
			};
		}

		const handler = dispatch[resolved];
		return handler(runtime, message, state, options, callback);
	},

	examples: [
		[
			{
				name: "{{user1}}",
				content: { text: "What secrets do I have?" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Found 2 global secret(s).",
					action: "SECRETS",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Do I have a Discord token set?" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Missing: DISCORD_BOT_TOKEN.",
					action: "SECRETS",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Delete my old Twitter API key" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "I've deleted your TWITTER_API_KEY.",
					action: "SECRETS",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Set my OpenAI API key to sk-abc123xyz789" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "I've securely stored your OPENAI_API_KEY. It's now available for use.",
					action: "SECRETS",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "I need an OpenAI key to continue." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "I need OPENAI_API_KEY. Use the authenticated Eliza Cloud setup link when it appears. Do not paste the value into a public channel.",
					action: "SECRETS",
				},
			},
		],
	] as ActionExample[][],
};

export { maskSecretValue } from "./mask.ts";
