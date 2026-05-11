/**
 * Check Secret Action
 *
 * Atomic action: report which of a list of secret keys exist.
 * Returns parallel arrays — never returns values.
 */

import { logger } from "../../../logger.ts";
import type {
	Action,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../types/index.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../services/secrets.ts";
import type { SecretContext, SecretLevel } from "../types.ts";

interface CheckSecretParams {
	keys: string[];
	level?: SecretLevel;
}

function normalizeKey(input: string): string {
	return input.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
}

function readParams(options: HandlerOptions | undefined): CheckSecretParams {
	const params =
		options?.parameters && typeof options.parameters === "object"
			? (options.parameters as Record<string, unknown>)
			: {};
	const rawKeys = params.key;
	const keys = Array.isArray(rawKeys)
		? rawKeys.filter((value): value is string => typeof value === "string")
		: typeof rawKeys === "string"
			? [rawKeys]
			: [];
	const level =
		params.level === "global" ||
		params.level === "world" ||
		params.level === "user"
			? (params.level as SecretLevel)
			: undefined;
	return { keys, level };
}

export const checkSecretAction: Action = {
	name: "CHECK_SECRET",
	contexts: ["secrets", "settings", "connectors"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	similes: ["HAS_SECRET", "VERIFY_SECRET", "SECRET_EXISTS"],
	description: "Check which of one or more secret keys are currently set.",
	parameters: [
		{
			name: "key",
			description: "Secret key or array of keys to check.",
			required: true,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
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
	],

	validate: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE) === null) {
			return false;
		}
		const { keys } = readParams(options);
		return keys.length > 0;
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	) => {
		const secretsService =
			runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
		if (!secretsService) {
			return {
				success: false,
				text: "Secrets service not available",
				data: { actionName: "CHECK_SECRET" },
			};
		}

		const { keys: rawKeys, level: rawLevel } = readParams(options);
		if (rawKeys.length === 0) {
			return {
				success: false,
				text: "Missing required parameter: key",
				data: { actionName: "CHECK_SECRET" },
			};
		}

		const level: SecretLevel = rawLevel ?? "global";
		const context: SecretContext = {
			level,
			agentId: runtime.agentId,
			worldId: level === "world" ? (message.roomId as string) : undefined,
			userId: level === "user" ? (message.entityId as string) : undefined,
			requesterId: message.entityId as string,
		};

		const normalizedKeys = rawKeys.map(normalizeKey);
		const present: boolean[] = [];
		const missing: string[] = [];
		for (const key of normalizedKeys) {
			const exists = await secretsService.exists(key, context);
			present.push(exists);
			if (!exists) missing.push(key);
		}

		logger.info(
			`[CheckSecret] level=${level} checked=${normalizedKeys.length} missing=${missing.length}`,
		);

		const text =
			missing.length === 0
				? `All ${normalizedKeys.length} secret(s) are set.`
				: `Missing: ${missing.join(", ")}.`;

		if (callback) {
			await callback({ text, action: "CHECK_SECRET" });
		}

		return {
			success: true,
			text,
			data: { actionName: "CHECK_SECRET", present, missing },
		};
	},

	examples: [],
};
