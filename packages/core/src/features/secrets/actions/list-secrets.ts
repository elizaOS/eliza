/**
 * List Secrets Action
 *
 * Atomic action: list secret keys + non-sensitive metadata.
 * NEVER returns secret values.
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

interface ListSecretsParams {
	level?: SecretLevel;
	prefix?: string;
}

interface ListSecretsMetadataEntry {
	setAt: number | undefined;
	lastUsedAt: number | undefined;
	ttl?: number;
}

function readParams(options: HandlerOptions | undefined): ListSecretsParams {
	const params =
		options?.parameters && typeof options.parameters === "object"
			? (options.parameters as Record<string, unknown>)
			: {};
	const level =
		params.level === "global" ||
		params.level === "world" ||
		params.level === "user"
			? (params.level as SecretLevel)
			: undefined;
	const prefix = typeof params.prefix === "string" ? params.prefix : undefined;
	return { level, prefix };
}

export const listSecretsAction: Action = {
	name: "LIST_SECRETS",
	contexts: ["secrets", "settings", "connectors"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	similes: ["LIST_SECRET", "ENUMERATE_SECRETS", "SHOW_SECRETS"],
	description:
		"List secret keys and non-sensitive metadata; never returns values.",
	parameters: [
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
			name: "prefix",
			description: "Optional key prefix filter (case-insensitive).",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (runtime: IAgentRuntime): Promise<boolean> => {
		return runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE) !== null;
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
				data: { actionName: "LIST_SECRETS" },
			};
		}

		const { level: rawLevel, prefix } = readParams(options);
		const level: SecretLevel = rawLevel ?? "global";
		const context: SecretContext = {
			level,
			agentId: runtime.agentId,
			worldId: level === "world" ? (message.roomId as string) : undefined,
			userId: level === "user" ? (message.entityId as string) : undefined,
			requesterId: message.entityId as string,
		};

		const allMetadata = await secretsService.list(context);
		const filterPrefix = prefix?.toUpperCase();
		const keys = Object.keys(allMetadata)
			.filter((key) =>
				filterPrefix ? key.toUpperCase().startsWith(filterPrefix) : true,
			)
			.sort();

		const metadata: Record<string, ListSecretsMetadataEntry> = {};
		const now = Date.now();
		for (const key of keys) {
			const config = allMetadata[key];
			const ttl =
				typeof config.expiresAt === "number"
					? Math.max(0, config.expiresAt - now)
					: undefined;
			metadata[key] = {
				setAt: config.createdAt,
				lastUsedAt: config.validatedAt,
				...(ttl !== undefined ? { ttl } : {}),
			};
		}

		logger.info(
			`[ListSecrets] level=${level} prefix=${prefix ?? ""} count=${keys.length}`,
		);

		const text =
			keys.length === 0
				? `You don't have any ${level} secrets stored yet.`
				: `Found ${keys.length} ${level} secret(s).`;

		if (callback) {
			await callback({ text, action: "LIST_SECRETS" });
		}

		return {
			success: true,
			text,
			data: {
				actionName: "LIST_SECRETS",
				keys,
				metadata,
			},
		};
	},

	examples: [],
};
