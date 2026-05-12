/**
 * Check Secret Handler
 *
 * Atomic handler: report which of a list of secret keys exist. Returns
 * parallel arrays — never returns values. Invoked by the `SECRETS` umbrella
 * when `action=check`.
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

export async function checkSecretHandler(
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
			data: { actionName: "SECRETS", action: "check" },
		};
	}

	const { keys: rawKeys, level: rawLevel } = readParams(options);
	if (rawKeys.length === 0) {
		return {
			success: false,
			text: "Missing required parameter: key",
			data: { actionName: "SECRETS", action: "check" },
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
		`[SECRETS:check] level=${level} checked=${normalizedKeys.length} missing=${missing.length}`,
	);

	const text =
		missing.length === 0
			? `All ${normalizedKeys.length} secret(s) are set.`
			: `Missing: ${missing.join(", ")}.`;

	if (callback) {
		await callback({ text, action: "SECRETS" });
	}

	return {
		success: true,
		text,
		data: { actionName: "SECRETS", action: "check", present, missing },
	};
}
