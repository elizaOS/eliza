import { logger } from "../../../logger.ts";
import { extractSecretRequestTemplate as extractRequestTemplate } from "../../../prompts.ts";
import {
	type Action,
	type ActionExample,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type State,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../services/secrets.ts";

export const requestSecretAction: Action = {
	name: "REQUEST_SECRET",
	contexts: ["secrets", "settings", "connectors"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	similes: [
		"ASK_FOR_SECRET",
		"REQUIRE_SECRET",
		"NEED_SECRET",
		"MISSING_SECRET",
	],
	description: "Request a missing secret from the user or administrator",
	parameters: [
		{
			name: "key",
			description:
				"Name of the missing secret, usually UPPERCASE_WITH_UNDERSCORES.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "reason",
			description: "Why the secret is needed.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		if (!runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE)) {
			return false;
		}
		const params =
			_options?.parameters && typeof _options.parameters === "object"
				? (_options.parameters as Record<string, unknown>)
				: {};
		const hasStructuredKey =
			typeof params.key === "string" && params.key.trim().length > 0;
		const text = message.content?.text?.toLowerCase() ?? "";
		return (
			hasStructuredKey ||
			/\b(?:request|need|missing|require).*\b(?:secret|key|token|credential)\b/i.test(
				text,
			) ||
			hasActionContextOrKeyword(message, _state, {
				contexts: ["secrets", "settings", "connectors"],
				keywords: [
					"request secret",
					"need secret",
					"missing secret",
					"require api key",
				],
			})
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		logger.info("[RequestSecret] Processing secret request");

		const currentState = state ?? (await runtime.composeState(message));

		const params =
			_options?.parameters && typeof _options.parameters === "object"
				? (_options.parameters as Record<string, unknown>)
				: {};

		try {
			const result = await runtime.dynamicPromptExecFromState({
				state: currentState,
				params: {
					prompt: extractRequestTemplate,
				},
				schema: [
					{
						field: "key",
						description:
							"Name of the missing secret, usually UPPERCASE_WITH_UNDERSCORES",
						required: false,
						validateField: false,
						streamField: false,
					},
					{
						field: "reason",
						description: "Why the secret is needed",
						required: false,
						validateField: false,
						streamField: false,
					},
				],
				options: {
					modelType: ModelType.TEXT_SMALL,
					preferredEncapsulation: "json",
					contextCheckLevel: 0,
					maxRetries: 1,
				},
			});

			const rawKey = params.key ?? result?.key;
			if (!rawKey) {
				logger.warn(
					"[RequestSecret] Failed to extract secret key from context",
				);
				return {
					success: false,
					text: "Failed to identify the required secret.",
					data: { actionName: "REQUEST_SECRET" },
				};
			}

			const key = String(rawKey)
				.toUpperCase()
				.replace(/[^A-Z0-9_]/g, "_");

			// Check if it already exists
			const service = runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
			if (service) {
				const exists = await service.exists(key, {
					level: "global", // Check global/user level
					agentId: runtime.agentId,
					userId:
						message.entityId !== runtime.agentId
							? String(message.entityId)
							: undefined,
				});

				if (exists) {
					const text = `The secret '${key}' is already available. You can use it now.`;
					if (callback) await callback({ text, action: "REQUEST_SECRET" });
					return {
						success: true,
						text,
						data: { actionName: "REQUEST_SECRET", key, exists: true },
					};
				}
			}

			const reason =
				typeof params.reason === "string" && params.reason.trim()
					? params.reason.trim()
					: typeof result?.reason === "string" && result.reason.trim()
						? result.reason.trim()
						: undefined;
			const text = `I require the secret '${key}' to proceed${reason ? ` (${reason})` : ""}. Please provide it securely using 'set secret ${key} <value>'.`;

			if (callback) {
				await callback({
					text,
					action: "REQUEST_SECRET",
					content: {
						secretRequest: {
							key,
							reason,
						},
					},
				});
			}

			return {
				success: true,
				text,
				data: { actionName: "REQUEST_SECRET", key, exists: false },
			};
		} catch (error) {
			logger.error("[RequestSecret] Error:", String(error));
			return {
				success: false,
				text: "Failed to process secret request",
				error: error instanceof Error ? error.message : String(error),
				data: { actionName: "REQUEST_SECRET" },
			};
		}
	},

	examples: [
		[
			{
				name: "{{user1}}",
				content: { text: "I need an OpenAI key to continue." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "I require the secret 'OPENAI_API_KEY' to proceed. Please provide it securely using 'set secret OPENAI_API_KEY <value>'.",
					action: "REQUEST_SECRET",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: {
					text: "I cannot access the database without a connection string.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "I require the secret 'DATABASE_URL' to proceed (database access). Please provide it securely using 'set secret DATABASE_URL <value>'.",
					action: "REQUEST_SECRET",
				},
			},
		],
	] as ActionExample[][],
};
