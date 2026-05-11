/**
 * Delete Secret Handler
 *
 * Atomic handler: remove a single secret from the store. DM-only. Invoked by
 * the `SECRETS` umbrella when `action=delete`.
 */

import { logger } from "../../../logger.ts";
import {
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

export async function deleteSecretHandler(
	runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
	options?: HandlerOptions,
	callback?: HandlerCallback,
) {
	const channelType = message.content.channelType;
	if (channelType !== undefined && channelType !== ChannelType.DM) {
		logger.warn(
			"[SECRETS:delete] Refused: attempted to delete secret in non-DM channel",
		);
		if (callback) {
			await callback({
				text: "I can't manage secrets in a public channel. Please send me a direct message (DM) for secret operations.",
				action: "SECRETS",
			});
		}
		return {
			success: false,
			text: "Refused: secrets can only be managed in DMs",
			data: { actionName: "SECRETS", action: "delete", deleted: false },
		};
	}

	const secretsService =
		runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
	if (!secretsService) {
		return {
			success: false,
			text: "Secrets service not available",
			data: { actionName: "SECRETS", action: "delete", deleted: false },
		};
	}

	const { key: rawKey, level: rawLevel } = readParams(options);
	if (!rawKey) {
		return {
			success: false,
			text: "Missing required parameter: key",
			data: { actionName: "SECRETS", action: "delete", deleted: false },
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
	logger.info(`[SECRETS:delete] ${key} (level=${level}, deleted=${deleted})`);

	const text = deleted
		? `I've deleted your ${key}.`
		: `I couldn't find a ${key} to delete.`;

	if (callback) {
		await callback({ text, action: "SECRETS" });
	}

	return {
		success: true,
		text,
		data: { actionName: "SECRETS", action: "delete", deleted },
	};
}
