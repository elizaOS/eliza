/**
 * Get Secret Handler
 *
 * Atomic handler: read a single secret value. Returns the value (optionally
 * masked) without exposing additional metadata. Invoked by the `SECRETS`
 * umbrella when `action=get`.
 */

import { logger } from "../../../logger.ts";
import type {
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

export async function getSecretHandler(
	runtime: IAgentRuntime,
	message: Memory,
	_state?: State,
	options?: HandlerOptions,
	callback?: HandlerCallback,
) {
	const secretsService =
		runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
	if (!secretsService) {
		return {
			success: false,
			text: "Secrets service not available",
			data: { actionName: "SECRETS", action: "get" },
		};
	}

	const { key: rawKey, level: rawLevel, mask } = readParams(options);
	if (!rawKey) {
		return {
			success: false,
			text: "Missing required parameter: key",
			data: { actionName: "SECRETS", action: "get" },
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

	logger.info(`[SECRETS:get] ${key} (level=${level}, masked=${shouldMask})`);

	const text =
		value === null
			? `I don't have a ${key} stored.`
			: `Your ${key} is set to: ${display}`;

	if (callback) {
		await callback({ text, action: "SECRETS" });
	}

	return {
		success: true,
		text,
		data: {
			actionName: "SECRETS",
			action: "get",
			value: display,
			masked: value !== null && shouldMask,
		},
	};
}
