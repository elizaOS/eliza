/**
 * Mirror Secret To Vault Action
 *
 * Atomic action: read a secret from the SecretsService and push a copy into
 * an external vault service (e.g. Steward). Returns `{ mirrored: false }`
 * when the vault service is not registered.
 */

import { logger } from "../../../logger.ts";
import {
	type Action,
	ChannelType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type Memory,
	type Service,
	type State,
} from "../../../types/index.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../services/secrets.ts";
import type { SecretContext, SecretLevel } from "../types.ts";

interface MirrorSecretParams {
	key: string;
	vaultName: string;
	level?: SecretLevel;
}

/**
 * Minimal vault contract this action will call into. Any service that
 * exposes an async `setSecret(key, value)` method is acceptable as a
 * mirror target. We don't import a vault interface here because the
 * core package must not depend on Steward/Vault implementations.
 */
interface VaultLike extends Service {
	setSecret(key: string, value: string): Promise<boolean>;
}

function readParams(
	options: HandlerOptions | undefined,
): Partial<MirrorSecretParams> {
	const params =
		options?.parameters && typeof options.parameters === "object"
			? (options.parameters as Record<string, unknown>)
			: {};
	const key = typeof params.key === "string" ? params.key : undefined;
	const vaultName =
		typeof params.vaultName === "string" ? params.vaultName : undefined;
	const level =
		params.level === "global" ||
		params.level === "world" ||
		params.level === "user"
			? (params.level as SecretLevel)
			: undefined;
	return { key, vaultName, level };
}

function isVaultLike(value: unknown): value is VaultLike {
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as { setSecret?: unknown }).setSecret === "function"
	);
}

export const mirrorSecretToVaultAction: Action = {
	name: "MIRROR_SECRET_TO_VAULT",
	contexts: ["secrets", "settings", "connectors"],
	roleGate: { minRole: "OWNER" },
	suppressPostActionContinuation: true,
	similes: ["COPY_SECRET_TO_VAULT", "VAULT_MIRROR_SECRET"],
	description:
		"Mirror an existing secret into an external vault service (e.g. Steward) by name.",
	parameters: [
		{
			name: "key",
			description: "Secret key, usually UPPERCASE_WITH_UNDERSCORES.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "vaultName",
			description: "Service name of the vault to mirror into.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "level",
			description: "Storage level to read the source secret from.",
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
		const { key, vaultName } = readParams(options);
		return (
			typeof key === "string" &&
			key.length > 0 &&
			typeof vaultName === "string" &&
			vaultName.length > 0
		);
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
				data: { actionName: "MIRROR_SECRET_TO_VAULT", mirrored: false },
			};
		}

		const { key: rawKey, vaultName, level: rawLevel } = readParams(options);
		if (!rawKey || !vaultName) {
			return {
				success: false,
				text: "Missing required parameter: key or vaultName",
				data: { actionName: "MIRROR_SECRET_TO_VAULT", mirrored: false },
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
		if (value === null) {
			const text = `I don't have a ${key} stored to mirror.`;
			if (callback) {
				await callback({ text, action: "MIRROR_SECRET_TO_VAULT" });
			}
			return {
				success: false,
				text,
				data: { actionName: "MIRROR_SECRET_TO_VAULT", mirrored: false },
			};
		}

		const vaultService = runtime.getService<Service>(vaultName);
		if (!isVaultLike(vaultService)) {
			logger.warn(
				`[MirrorSecretToVault] Vault service '${vaultName}' is not available or does not implement setSecret`,
			);
			const text = `Vault service '${vaultName}' is not available.`;
			if (callback) {
				await callback({ text, action: "MIRROR_SECRET_TO_VAULT" });
			}
			return {
				success: false,
				text,
				data: { actionName: "MIRROR_SECRET_TO_VAULT", mirrored: false },
			};
		}

		const mirrored = await vaultService.setSecret(key, value);
		logger.info(
			`[MirrorSecretToVault] ${key} -> ${vaultName} (mirrored=${mirrored})`,
		);

		const text = mirrored
			? `Mirrored ${key} into ${vaultName}.`
			: `Failed to mirror ${key} into ${vaultName}.`;

		if (callback) {
			await callback({ text, action: "MIRROR_SECRET_TO_VAULT" });
		}

		return {
			success: mirrored,
			text,
			data: { actionName: "MIRROR_SECRET_TO_VAULT", mirrored },
		};
	},

	examples: [],
};
