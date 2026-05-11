/**
 * Get Secret Action
 *
 * Atomic action: read a single secret value.
 * Returns the value (optionally masked) without exposing additional metadata.
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
import { maskSecretValue } from "./manage-secret.ts";

interface GetSecretParams {
	key: string;
	level?: SecretLevel;
	mask: boolean;
}

function readParams(
	options: HandlerOptions | undefined,
): Partial<GetSecretParams> {
	const params =
		options?.parameters && typeof options.parameters === "object"
			? (options.parameters as Record<string, unknown>)
			: {};
	const key = typeof params.key === "string" ? params.key : undefined;
	const level =
		params.level === "global" ||
		params.level === "world" ||
		params.level === "user"
			? (params.level as SecretLevel)
			: undefined;
	const mask =
		typeof params.mask === "boolean" ? (params.mask as boolean) : undefined;
	return { key, level, mask };
}

export const getSecretAction: Action = {
	name: "GET_SECRET",
	contexts: ["secrets", "settings", "connectors"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	similes: ["READ_SECRET", "FETCH_SECRET", "RETRIEVE_SECRET"],
	description: "Read a single secret value (optionally masked).",
	parameters: [
		{
			name: "key",
			description: "Secret key, usually UPPERCASE_WITH_UNDERSCORES.",
			required: true,
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
			description: "When true, mask the returned value for display.",
			required: false,
			schema: { type: "boolean" as const },
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
		const { key } = readParams(options);
		return typeof key === "string" && key.length > 0;
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
				data: { actionName: "GET_SECRET" },
			};
		}

		const { key: rawKey, level: rawLevel, mask } = readParams(options);
		if (!rawKey) {
			return {
				success: false,
				text: "Missing required parameter: key",
				data: { actionName: "GET_SECRET" },
			};
		}

		const key = rawKey.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
		const level: SecretLevel = rawLevel ?? "global";
		const context: SecretContext = {
			level,
			agentId: runtime.agentId,
			worldId: level === "world" ? (message.roomId as string) : undefined,
			userId: level === "user" ? (message.entityId as string) : undefined,
			requesterId: message.entityId as string,
		};

		const value = await secretsService.get(key, context);
		const shouldMask = mask !== false;
		const display =
			value === null ? null : shouldMask ? maskSecretValue(value) : value;

		logger.info(`[GetSecret] ${key} (level=${level}, masked=${shouldMask})`);

		const text =
			value === null
				? `I don't have a ${key} stored.`
				: `Your ${key} is set to: ${display}`;

		if (callback) {
			await callback({ text, action: "GET_SECRET" });
		}

		return {
			success: true,
			text,
			data: {
				actionName: "GET_SECRET",
				value: display,
				masked: value !== null && shouldMask,
			},
		};
	},

	examples: [],
};
