/**
 * Delete Secret Action
 *
 * Atomic action: remove a single secret from the store. DM-only.
 */

import { logger } from "../../../logger.ts";
import {
	type Action,
	ChannelType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	type State,
} from "../../../types/index.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../services/secrets.ts";
import type { SecretContext, SecretLevel } from "../types.ts";

interface DeleteSecretParams {
	key: string;
	level?: SecretLevel;
}

function readParams(
	options: HandlerOptions | undefined,
): Partial<DeleteSecretParams> {
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
	return { key, level };
}

export const deleteSecretAction: Action = {
	name: "DELETE_SECRET",
	contexts: ["secrets", "settings", "connectors"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	similes: ["REMOVE_SECRET", "ERASE_SECRET", "PURGE_SECRET"],
	description: "Delete a single secret. DM-only.",
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
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		if (runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE) === null) {
			return false;
		}
		const channelType = message.content.channelType;
		if (channelType !== undefined && channelType !== ChannelType.DM) {
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
		const channelType = message.content.channelType;
		if (channelType !== undefined && channelType !== ChannelType.DM) {
			logger.warn(
				"[DeleteSecret] Refused: attempted to delete secret in non-DM channel",
			);
			if (callback) {
				await callback({
					text: "I can't manage secrets in a public channel. Please send me a direct message (DM) for secret operations.",
					action: "DELETE_SECRET",
				});
			}
			return {
				success: false,
				text: "Refused: secrets can only be managed in DMs",
				data: { actionName: "DELETE_SECRET", deleted: false },
			};
		}

		const secretsService =
			runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
		if (!secretsService) {
			return {
				success: false,
				text: "Secrets service not available",
				data: { actionName: "DELETE_SECRET", deleted: false },
			};
		}

		const { key: rawKey, level: rawLevel } = readParams(options);
		if (!rawKey) {
			return {
				success: false,
				text: "Missing required parameter: key",
				data: { actionName: "DELETE_SECRET", deleted: false },
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

		const deleted = await secretsService.delete(key, context);
		logger.info(`[DeleteSecret] ${key} (level=${level}, deleted=${deleted})`);

		const text = deleted
			? `I've deleted your ${key}.`
			: `I couldn't find a ${key} to delete.`;

		if (callback) {
			await callback({ text, action: "DELETE_SECRET" });
		}

		return {
			success: true,
			text,
			data: { actionName: "DELETE_SECRET", deleted },
		};
	},

	examples: [],
};
