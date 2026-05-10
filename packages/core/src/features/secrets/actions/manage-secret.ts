/**
 * Manage Secret Action
 *
 * Comprehensive action for managing secrets through natural language.
 * Supports get, set, delete, and list operations at different levels.
 */

import { logger } from "../../../logger.ts";
import { extractSecretOperationTemplate as extractOperationTemplate } from "../../../prompts.ts";
import {
	type Action,
	type ActionExample,
	ChannelType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type State,
} from "../../../types/index.ts";
import { hasActionContext } from "../../../utils/action-validation.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../services/secrets.ts";
import type { SecretContext, SecretType } from "../types.ts";

/**
 * Type for secret management operation
 */
interface SecretOperation {
	operation: "get" | "set" | "delete" | "list" | "check";
	key?: string;
	value?: string;
	level?: "global" | "world" | "user";
	description?: string;
	type?: "api_key" | "secret" | "credential" | "url" | "config";
}

/**
 * Manage Secret Action
 */
export const manageSecretAction: Action = {
	name: "MANAGE_SECRET",
	contexts: ["secrets", "settings", "connectors"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	similes: [
		"SECRET_MANAGEMENT",
		"HANDLE_SECRET",
		"SECRET_OPERATION",
		"GET_SECRET",
		"DELETE_SECRET",
		"LIST_SECRETS",
		"CHECK_SECRET",
	],
	description:
		"Manage secrets - get, set, delete, or list secrets at various levels",
	parameters: [
		{
			name: "subaction",
			description: "Secret operation: get, set, delete, list, or check.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["get", "set", "delete", "list", "check"],
			},
		},
		{
			name: "operation",
			description:
				"Legacy alias for subaction, accepted for planner compatibility.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "key",
			description: "Secret key, usually UPPERCASE_WITH_UNDERSCORES.",
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
			name: "description",
			description: "Optional short description for the secret.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "type",
			description: "Secret type.",
			required: false,
			schema: {
				type: "string" as const,
				enum: ["api_key", "secret", "credential", "url", "config"],
			},
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		if (runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE) === null) {
			return false;
		}
		const channelType = message.content.channelType;
		if (channelType !== undefined && channelType !== ChannelType.DM) {
			return false;
		}
		const params =
			_options?.parameters && typeof _options.parameters === "object"
				? (_options.parameters as Record<string, unknown>)
				: {};
		const subactionField =
			(typeof params.subaction === "string" && params.subaction.trim().length > 0
				? params.subaction
				: typeof params.operation === "string" &&
						params.operation.trim().length > 0
					? params.operation
					: undefined);
		const hasStructuredOperation = typeof subactionField === "string";
		return (
			hasStructuredOperation ||
			hasActionContext(message, _state, {
				contexts: ["secrets", "settings", "connectors"],
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
		logger.info("[ManageSecret] Processing secret management request");

		// Security: Refuse to manage secrets in non-DM channels
		const channelType = message.content.channelType;
		if (channelType !== undefined && channelType !== ChannelType.DM) {
			logger.warn(
				"[ManageSecret] Refused: attempted to manage secrets in non-DM channel",
			);
			if (callback) {
				await callback({
					text: "I can't manage secrets in a public channel. Please send me a direct message (DM) for secret operations. Never share sensitive information in public channels.",
					action: "MANAGE_SECRET",
				});
			}
			return {
				success: false,
				text: "Refused: secrets can only be managed in DMs",
				data: { actionName: "MANAGE_SECRET" },
			};
		}

		const secretsService =
			runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
		if (!secretsService) {
			if (callback) {
				await callback({
					text: "Secret management is not available.",
					action: "MANAGE_SECRET",
				});
			}
			return {
				success: false,
				text: "Secrets service not available",
				data: { actionName: "MANAGE_SECRET" },
			};
		}

		// Build state for prompt
		const currentState = state ?? (await runtime.composeState(message));

		const params =
			_options?.parameters && typeof _options.parameters === "object"
				? (_options.parameters as Record<string, unknown>)
				: {};

		// Extract operation from structured parameters or user message
		let operation: SecretOperation;
		try {
			const result = await runtime.dynamicPromptExecFromState({
				state: currentState,
				params: {
					prompt: extractOperationTemplate,
				},
				schema: [
					{
						field: "operation",
						description: "Secret operation: get, set, delete, list, or check",
						required: true,
						validateField: false,
						streamField: false,
					},
					{
						field: "key",
						description: "Secret key, usually UPPERCASE_WITH_UNDERSCORES",
						required: false,
						validateField: false,
						streamField: false,
					},
					{
						field: "value",
						description: "Secret value when setting a secret",
						required: false,
						validateField: false,
						streamField: false,
					},
					{
						field: "level",
						description: "Storage level: global, world, or user",
						required: false,
						validateField: false,
						streamField: false,
					},
					{
						field: "description",
						description: "Optional short description for the secret",
						required: false,
						validateField: false,
						streamField: false,
					},
					{
						field: "type",
						description:
							"Secret type: api_key, secret, credential, url, or config",
						required: false,
						validateField: false,
						streamField: false,
					},
				],
				options: {
					modelType: ModelType.TEXT_SMALL,
					contextCheckLevel: 0,
					maxRetries: 1,
				},
			});

			// Transform and validate result
			operation = {
				operation:
					(params.subaction as SecretOperation["operation"]) ||
					(params.operation as SecretOperation["operation"]) ||
					(result?.operation as SecretOperation["operation"]) ||
					"list",
				key: params.key
					? String(params.key)
					: result?.key
						? String(result.key)
						: undefined,
				value: params.value
					? String(params.value)
					: result?.value
						? String(result.value)
						: undefined,
				level:
					(params.level as SecretOperation["level"]) ||
					(result?.level as SecretOperation["level"]),
				description: params.description
					? String(params.description)
					: result?.description
						? String(result.description)
						: undefined,
				type: params.type
					? (params.type as SecretOperation["type"])
					: (result?.type as SecretOperation["type"]),
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error(
				`[ManageSecret] Failed to extract operation: ${errorMessage}`,
			);
			if (callback) {
				await callback({
					text: "I had trouble understanding what you want to do with secrets. Could you be more specific?",
					action: "MANAGE_SECRET",
				});
			}
			return {
				success: false,
				text: "Failed to extract operation from message",
				data: { actionName: "MANAGE_SECRET" },
			};
		}

		// Determine storage context
		const level = operation.level ?? "global";
		const context: SecretContext = {
			level,
			agentId: runtime.agentId,
			worldId: level === "world" ? (message.roomId as string) : undefined,
			userId: level === "user" ? (message.entityId as string) : undefined,
			requesterId: message.entityId as string,
		};

		// Execute the operation
		let responseText: string;

		switch (operation.operation) {
			case "get": {
				if (!operation.key) {
					responseText = "Please specify which secret you want to retrieve.";
					break;
				}

				const key = operation.key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
				const value = await secretsService.get(key, context);

				if (value) {
					// Never reveal full secret values - show partial
					const maskedValue = maskSecretValue(value);
					responseText = `Your ${key} is set to: ${maskedValue}`;
				} else {
					responseText = `I don't have a ${key} stored. Would you like to set one?`;
				}
				break;
			}

			case "set": {
				if (!operation.key || !operation.value) {
					responseText = "Please provide both a key and value to set a secret.";
					break;
				}

				const key = operation.key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

				try {
					const success = await secretsService.set(
						key,
						operation.value,
						context,
						{
							type: (operation.type as SecretType) ?? "secret",
							description: operation.description ?? "Set via conversation",
							encrypted: true,
						},
					);

					if (success) {
						responseText = `I've securely stored your ${key}.`;
					} else {
						responseText = `Failed to store ${key}. Please try again.`;
					}
				} catch (error) {
					responseText = `Error storing ${key}: ${error instanceof Error ? error.message : "Unknown error"}`;
				}
				break;
			}

			case "delete": {
				if (!operation.key) {
					responseText = "Please specify which secret you want to delete.";
					break;
				}

				const key = operation.key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
				const deleted = await secretsService.delete(key, context);

				if (deleted) {
					responseText = `I've deleted your ${key}.`;
				} else {
					responseText = `I couldn't find a ${key} to delete.`;
				}
				break;
			}

			case "list": {
				const metadata = await secretsService.list(context);
				const keys = Object.keys(metadata);

				if (keys.length === 0) {
					responseText = `You don't have any ${level} secrets stored yet.`;
				} else {
					const secretList = keys
						.map((key) => {
							const config = metadata[key];
							const status = config.status === "valid" ? "✓" : "⚠";
							return `• ${key} ${status}`;
						})
						.join("\n");

					responseText = `Here are your ${level} secrets:\n${secretList}`;
				}
				break;
			}

			case "check": {
				if (!operation.key) {
					responseText = "Please specify which secret you want to check.";
					break;
				}

				const key = operation.key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
				const exists = await secretsService.exists(key, context);

				if (exists) {
					const config = await secretsService.getConfig(key, context);
					const status =
						config?.status === "valid"
							? "valid"
							: (config?.status ?? "unknown");
					responseText = `Yes, ${key} is set and its status is: ${status}.`;
				} else {
					responseText = `No, ${key} is not set. Would you like to configure it?`;
				}
				break;
			}

			default:
				responseText =
					"I'm not sure what operation you want to perform. You can get, set, delete, list, or check secrets.";
		}

		if (callback) {
			await callback({
				text: responseText,
				action: "MANAGE_SECRET",
			});
		}

		return {
			success: true,
			text: responseText,
			data: { actionName: "MANAGE_SECRET", operation },
		};
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
					text: "Here are your global secrets:\n• OPENAI_API_KEY ✓\n• ANTHROPIC_API_KEY ✓",
					action: "MANAGE_SECRET",
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
					text: "No, DISCORD_BOT_TOKEN is not set. Would you like to configure it?",
					action: "MANAGE_SECRET",
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
					action: "MANAGE_SECRET",
				},
			},
		],
	] as ActionExample[][],
};

/**
 * Mask a secret value for display
 */
function maskSecretValue(value: string): string {
	if (value.length <= 8) {
		return "****";
	}

	const visibleStart = value.slice(0, 4);
	const visibleEnd = value.slice(-4);
	const maskedLength = Math.min(value.length - 8, 20);
	const mask = "*".repeat(maskedLength);

	return `${visibleStart}${mask}${visibleEnd}`;
}
