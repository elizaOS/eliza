/**
 * Set Secret Handler
 *
 * Atomic handler: store one or more secrets. Extracts key-value pairs from
 * structured parameters or the user message via LLM. Invoked by the `SECRETS`
 * umbrella when `action=set`.
 */

import { logger } from "../../../logger.ts";
import { extractSecretsTemplate } from "../../../prompts.ts";
import {
	ChannelType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	ModelType,
	type State,
} from "../../../types/index.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../services/secrets.ts";
import type { SecretContext, SecretType } from "../types.ts";
import { inferValidationStrategy } from "../validation.ts";

/**
 * Type for extracted secrets from user message
 */
interface ExtractedSecret {
	key: string;
	value: string;
	description?: string;
	type?: "api_key" | "secret" | "credential" | "url" | "config";
}

interface ExtractedSecrets {
	secrets: ExtractedSecret[];
	level?: "global" | "world" | "user";
}

export async function setSecretHandler(
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
	_options?: HandlerOptions,
	callback?: HandlerCallback,
) {
	logger.info("[SECRETS:set] Processing secret set request");

	// Security: Refuse to store secrets in non-DM channels
	const channelType = message.content.channelType;
	if (channelType !== undefined && channelType !== ChannelType.DM) {
		logger.warn(
			"[SECRETS:set] Refused: attempted to set secret in non-DM channel",
		);
		if (callback) {
			await callback({
				text: "I can't handle secrets in a public channel. Please send me a direct message (DM) to set secrets securely. Never share API keys or tokens in public channels.",
				action: "SECRETS",
			});
		}
		return {
			success: false,
			text: "Refused: secrets can only be set in DMs",
			data: { actionName: "SECRETS", action: "set" },
		};
	}

	const secretsService =
		runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
	if (!secretsService) {
		// Planner-facing only: plugin-config boilerplate is not actionable for
		// a chat user; the evaluator phrases the failure in voice.
		return {
			success: false,
			text: "Secrets service is unavailable; tell the user secrets can't be stored right now.",
			data: { actionName: "SECRETS", action: "set" },
		};
	}

	// Build state for prompt
	const currentState = state ?? (await runtime.composeState(message));

	const params =
		_options?.parameters && typeof _options.parameters === "object"
			? (_options.parameters as Record<string, unknown>)
			: {};

	// Extract secrets from structured parameters or user message using LLM
	let extracted: ExtractedSecrets;
	try {
		const result = await runtime.dynamicPromptExecFromState({
			state: currentState,
			params: {
				prompt: extractSecretsTemplate,
			},
			schema: [
				{
					field: "secrets",
					description: "Secrets extracted from the user's message",
					type: "array",
					items: {
						description: "One extracted secret",
						type: "object",
						properties: [
							{
								field: "key",
								description: "Secret key, usually UPPERCASE_WITH_UNDERSCORES",
								required: true,
							},
							{
								field: "value",
								description: "Secret value",
								required: true,
							},
							{
								field: "description",
								description: "Optional short description",
								required: false,
							},
							{
								field: "type",
								description:
									"Secret type: api_key, secret, credential, url, config",
								required: false,
							},
						],
					},
					required: true,
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
			],
			options: {
				modelType: ModelType.TEXT_SMALL,
				contextCheckLevel: 0,
				maxRetries: 1,
			},
		});

		// Validate and transform the result
		const secretsArray = Array.isArray(params.secrets)
			? params.secrets
			: Array.isArray(result?.secrets)
				? result.secrets
				: [];
		extracted = {
			secrets: secretsArray
				.filter(
					(s): s is Record<string, unknown> =>
						s !== null && typeof s === "object",
				)
				.map((s) => ({
					key: String(s.key || ""),
					value: String(s.value || ""),
					description: s.description ? String(s.description) : undefined,
					type: s.type as ExtractedSecret["type"],
				}))
				.filter((s) => s.key && s.value),
			level:
				(params.level as ExtractedSecrets["level"]) ||
				(result?.level as ExtractedSecrets["level"]),
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		logger.error(`[SECRETS:set] Failed to extract secrets: ${errorMessage}`);
		// error-policy:J1 the action boundary translates extraction failure into
		// an explicit unsuccessful result visible to the model.
		// Planner-facing only: the canned clarification double-messaged next to
		// the evaluator's in-voice reply. The evaluator owns asking the user.
		return {
			success: false,
			text: 'Failed to extract secrets from the message; ask the user to restate it with a key and value, like "Set my OPENAI_API_KEY to sk-...".',
			data: { actionName: "SECRETS", action: "set" },
		};
	}

	if (extracted.secrets.length === 0) {
		return {
			success: false,
			text: 'No secrets found in the message; ask the user to provide a key and value, like "Set my OPENAI_API_KEY to sk-...".',
			data: { actionName: "SECRETS", action: "set" },
		};
	}

	// Determine storage context
	const level = extracted.level ?? "global";
	const context: SecretContext = {
		level,
		agentId: runtime.agentId,
		worldId: level === "world" ? message.roomId : undefined,
		userId: level === "user" ? message.entityId : undefined,
		requesterId: message.entityId,
	};

	// Store each extracted secret
	const results: Array<{ key: string; success: boolean; error?: string }> = [];

	for (const secret of extracted.secrets) {
		// Normalize key to uppercase
		const key = secret.key.toUpperCase().replace(/[^A-Z0-9_]/g, "_");

		// Infer validation strategy
		const validationMethod = inferValidationStrategy(key);

		try {
			const success = await secretsService.set(key, secret.value, context, {
				type: (secret.type as SecretType) ?? "secret",
				description: secret.description ?? `Secret set via conversation`,
				validationMethod,
				encrypted: true,
			});

			results.push({ key, success });

			if (success) {
				logger.info(`[SECRETS:set] Successfully set secret: ${key}`);
			}
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Unknown error";
			results.push({ key, success: false, error: errorMessage });
			logger.error(
				`[SECRETS:set] Failed to set secret ${key}: ${errorMessage}`,
			);
		}
	}

	// Generate response
	const successful = results.filter((r) => r.success);
	const failed = results.filter((r) => !r.success);

	let responseText: string;

	if (successful.length > 0 && failed.length === 0) {
		const keys = successful.map((r) => r.key).join(", ");
		responseText =
			successful.length === 1
				? `I've securely stored your ${keys}. It's now available for use.`
				: `I've securely stored ${successful.length} secrets: ${keys}. They're now available for use.`;
	} else if (successful.length === 0 && failed.length > 0) {
		const errors = failed.map((r) => `${r.key}: ${r.error}`).join("; ");
		responseText = `I wasn't able to store the secret(s). ${errors}`;
	} else {
		const successKeys = successful.map((r) => r.key).join(", ");
		const failedKeys = failed.map((r) => r.key).join(", ");
		responseText = `I stored ${successful.length} secret(s) (${successKeys}), but ${failed.length} failed (${failedKeys}).`;
	}

	if (callback) {
		await callback({
			text: responseText,
			action: "SECRETS",
		});
	}

	// The store confirmation is the complete answer to a single-operation
	// turn: verified + turnComplete make the callback the sole delivery
	// instead of double-confirming a secret write with an evaluator paraphrase.
	return {
		success: successful.length > 0,
		text: responseText,
		userFacingText: responseText,
		verifiedUserFacing: true,
		turnComplete: successful.length > 0,
		data: { actionName: "SECRETS", action: "set", results },
	};
}
