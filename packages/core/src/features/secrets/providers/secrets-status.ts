/**
 * Secrets Status Provider
 *
 * Provides context about the agent's secret configuration status
 * to help the LLM understand what capabilities are available.
 */

import { logger } from "../../../logger.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../types/index.ts";
import {
	PLUGIN_ACTIVATOR_SERVICE_TYPE,
	type PluginActivatorService,
} from "../services/plugin-activator.ts";
import {
	SECRETS_SERVICE_TYPE,
	type SecretsService,
} from "../services/secrets.ts";

const MAX_SECRET_KEYS = 20;
/**
 * Secrets Status Provider
 *
 * Adds information about configured secrets to the agent's context,
 * without exposing actual secret values.
 */
export const secretsStatusProvider: Provider = {
	name: "SECRETS_STATUS",
	description: "Provides information about configured secrets and their status",

	dynamic: true,
	contexts: ["secrets", "settings"],
	contextGate: { anyOf: ["secrets", "settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "OWNER" },

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		const secretsService =
			runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
		if (!secretsService) {
			return { text: "" };
		}

		try {
			// Get global secrets status
			const globalSecrets = await secretsService.list({
				level: "global",
				agentId: runtime.agentId,
			});

			const secretKeys = Object.keys(globalSecrets);

			if (secretKeys.length === 0) {
				return {
					text: `[Secrets Status]
No secrets are currently configured. The agent may need API keys or other credentials to access certain services.`,
				};
			}

			// Categorize secrets by status
			const valid: string[] = [];
			const missing: string[] = [];
			const invalid: string[] = [];

			for (const [key, config] of Object.entries(globalSecrets)) {
				switch (config.status) {
					case "valid":
						valid.push(key);
						break;
					case "missing":
						missing.push(key);
						break;
					case "invalid":
					case "expired":
					case "revoked":
						invalid.push(key);
						break;
					default:
						valid.push(key);
				}
			}

			// Build status message
			const lines: string[] = ["[Secrets Status]"];

			if (valid.length > 0) {
				lines.push(`Configured secrets: ${valid.join(", ")}`);
			}

			if (invalid.length > 0) {
				lines.push(`Invalid/expired secrets: ${invalid.join(", ")}`);
			}

			if (missing.length > 0) {
				lines.push(`Missing required secrets: ${missing.join(", ")}`);
			}

			// Check plugin activator for pending plugins
			const activatorService = runtime.getService<PluginActivatorService>(
				PLUGIN_ACTIVATOR_SERVICE_TYPE,
			);
			if (activatorService) {
				const pendingPlugins = activatorService.getPendingPlugins();
				if (pendingPlugins.length > 0) {
					lines.push(
						`Plugins waiting for secrets: ${pendingPlugins.join(", ")}`,
					);

					const requiredSecrets = activatorService.getRequiredSecrets();
					if (requiredSecrets.size > 0) {
						lines.push(
							`Secrets needed for pending plugins: ${Array.from(requiredSecrets).slice(0, MAX_SECRET_KEYS).join(", ")}`,
						);
					}
				}
			}

			return {
				text: lines.join("\n"),
				data: {
					configuredCount: valid.length,
					invalidCount: invalid.length,
					missingCount: missing.length,
					configuredKeys: valid.slice(0, MAX_SECRET_KEYS),
					invalidKeys: invalid.slice(0, MAX_SECRET_KEYS),
					missingKeys: missing.slice(0, MAX_SECRET_KEYS),
				},
				values: {
					configuredSecrets: valid.length,
					invalidSecrets: invalid.length,
					missingSecrets: missing.length,
				},
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error(
				`[SecretsStatusProvider] Error getting secrets status: ${errorMsg}`,
			);
			return {
				text: "",
				data: { error: errorMsg },
				values: {
					configuredSecrets: 0,
					invalidSecrets: 0,
					missingSecrets: 0,
				},
			};
		}
	},
};

/**
 * Secrets Info Provider
 *
 * Provides detailed information about specific secrets when relevant
 * to the current conversation context.
 */
export const secretsInfoProvider: Provider = {
	name: "SECRETS_INFO",
	description:
		"Provides detailed secret information based on conversation context",

	dynamic: true,
	contexts: ["secrets", "settings"],
	contextGate: { anyOf: ["secrets", "settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "OWNER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<ProviderResult> => {
		const secretsService =
			runtime.getService<SecretsService>(SECRETS_SERVICE_TYPE);
		if (!secretsService) {
			return { text: "" };
		}

		const text = message.content.text?.toLowerCase() ?? "";

		// Check if message is about secrets
		const isAboutSecrets =
			/\b(secret|key|token|credential|api|password|configure)\b/i.test(text);
		if (!isAboutSecrets) {
			return { text: "" };
		}

		try {
			const globalSecrets = await secretsService.list({
				level: "global",
				agentId: runtime.agentId,
			});

			const secretCount = Object.keys(globalSecrets).length;
			if (secretCount === 0) {
				return {
					text: `[Secrets Info]
No secrets configured. User can set secrets by saying things like "Set my OPENAI_API_KEY to sk-..."`,
				};
			}

			// Build detailed info
			const lines: string[] = ["[Secrets Info]"];
			lines.push(`Total configured secrets: ${secretCount}`);

			// Group by type
			const byType: Record<string, string[]> = {};
			for (const [key, config] of Object.entries(globalSecrets)) {
				const type = config.type ?? "secret";
				if (!byType[type]) {
					byType[type] = [];
				}
				byType[type].push(key);
			}

			for (const [type, keys] of Object.entries(byType)) {
				lines.push(`${type}: ${keys.slice(0, MAX_SECRET_KEYS).join(", ")}`);
			}

			// Check for common missing secrets that might be relevant
			const commonSecrets = [
				"OPENAI_API_KEY",
				"ANTHROPIC_API_KEY",
				"DISCORD_BOT_TOKEN",
				"TELEGRAM_BOT_TOKEN",
				"TWITTER_API_KEY",
			];

			const missingCommon = commonSecrets.filter((key) => !globalSecrets[key]);
			if (
				missingCommon.length > 0 &&
				missingCommon.length < commonSecrets.length
			) {
				lines.push(`Common secrets not set: ${missingCommon.join(", ")}`);
			}

			return {
				text: lines.join("\n"),
				data: {
					secretCount,
					secretTypes: Object.fromEntries(
						Object.entries(byType).map(([type, keys]) => [
							type,
							keys.slice(0, MAX_SECRET_KEYS),
						]),
					),
				},
				values: {
					secretCount,
				},
			};
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error(`[SecretsInfoProvider] Error: ${errorMsg}`);
			return {
				text: "",
				data: { error: errorMsg },
				values: { secretCount: 0 },
			};
		}
	},
};
