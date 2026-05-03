/**
 * Plugin Auto-Enable Tests
 *
 * Tests for plugins being auto-enabled based on secrets and config.
 * Tests allow/deny filtering.
 */

import { describe, expect, it } from "vitest";
import {
	CHANNEL_SECRETS,
	MODEL_PROVIDER_SECRETS,
	resolveSecretKeyAlias,
} from "../constants/secrets";

// ============================================================================
// Types
// ============================================================================

interface PluginManifest {
	id: string;
	name?: string;
	kind?: "provider" | "channel" | "service" | "action";
	requiredSecrets?: string[];
	optionalSecrets?: string[];
	channels?: string[];
	providers?: string[];
}

interface PluginAutoEnableConfig {
	secrets: Record<string, string>;
	allow?: string[];
	deny?: string[];
	autoEnable?: boolean;
}

interface PluginAutoEnableResult {
	pluginId: string;
	enabled: boolean;
	reason: string;
	missingSecrets?: string[];
}

// ============================================================================
// Auto-Enable Logic (for testing)
// ============================================================================

/**
 * Check if a plugin should be auto-enabled based on available secrets.
 */
function shouldAutoEnableBySecrets(
	manifest: PluginManifest,
	secrets: Record<string, string>,
): { shouldEnable: boolean; missing: string[] } {
	const required = manifest.requiredSecrets || [];
	const missing: string[] = [];

	for (const key of required) {
		// Resolve alias to canonical name
		const canonical = resolveSecretKeyAlias(key);
		const value = secrets[canonical] || secrets[key];

		if (!value || value.trim() === "") {
			missing.push(key);
		}
	}

	return {
		shouldEnable: missing.length === 0,
		missing,
	};
}

/**
 * Check if a plugin is allowed by allow/deny lists.
 */
function isPluginAllowed(
	pluginId: string,
	allow?: string[],
	deny?: string[],
): { allowed: boolean; reason: string } {
	// Deny list takes precedence
	if (deny && deny.length > 0) {
		if (deny.includes(pluginId) || deny.includes("*")) {
			return { allowed: false, reason: "Explicitly denied" };
		}
	}

	// Check allow list
	if (allow && allow.length > 0) {
		if (allow.includes(pluginId) || allow.includes("*")) {
			return { allowed: true, reason: "Explicitly allowed" };
		}
		return { allowed: false, reason: "Not in allow list" };
	}

	// Default: allowed if no lists specified
	return { allowed: true, reason: "No restrictions" };
}

/**
 * Auto-enable plugins based on configuration.
 */
function autoEnablePlugins(
	manifests: PluginManifest[],
	config: PluginAutoEnableConfig,
): PluginAutoEnableResult[] {
	const results: PluginAutoEnableResult[] = [];

	for (const manifest of manifests) {
		// Check allow/deny first
		const allowDeny = isPluginAllowed(manifest.id, config.allow, config.deny);

		if (!allowDeny.allowed) {
			results.push({
				pluginId: manifest.id,
				enabled: false,
				reason: allowDeny.reason,
			});
			continue;
		}

		// Check secrets
		const secretCheck = shouldAutoEnableBySecrets(manifest, config.secrets);

		if (!secretCheck.shouldEnable) {
			results.push({
				pluginId: manifest.id,
				enabled: false,
				reason: "Missing required secrets",
				missingSecrets: secretCheck.missing,
			});
			continue;
		}

		results.push({
			pluginId: manifest.id,
			enabled: true,
			reason: "All requirements met",
		});
	}

	return results;
}

/**
 * Get plugins that should be auto-enabled for a model provider.
 */
function getProviderPlugins(
	provider: string,
	secrets: Record<string, string>,
): string[] {
	const secretKey = MODEL_PROVIDER_SECRETS[provider];
	if (!secretKey) return [];

	const value = secrets[secretKey];
	if (!value || value.trim() === "") return [];

	return [`plugin-${provider}`];
}

/**
 * Get plugins that should be auto-enabled for a channel.
 */
function getChannelPlugins(
	channel: string,
	secrets: Record<string, string>,
): string[] {
	const required = CHANNEL_SECRETS[channel];
	if (!required) return [];

	const hasAll = required.every((key) => {
		const value = secrets[key];
		return value && value.trim() !== "";
	});

	return hasAll ? [`plugin-${channel}`] : [];
}

// ============================================================================
// Tests
// ============================================================================

describe("Plugin Auto-Enable", () => {
	describe("Auto-Enable by Secrets", () => {
		it("should enable plugin when all required secrets are present", () => {
			const manifest: PluginManifest = {
				id: "plugin-openai",
				requiredSecrets: ["OPENAI_API_KEY"],
			};

			const result = shouldAutoEnableBySecrets(manifest, {
				OPENAI_API_KEY: "sk-test12345678901234567890",
			});

			expect(result.shouldEnable).toBe(true);
			expect(result.missing).toHaveLength(0);
		});

		it("should not enable plugin when required secrets are missing", () => {
			const manifest: PluginManifest = {
				id: "plugin-openai",
				requiredSecrets: ["OPENAI_API_KEY"],
			};

			const result = shouldAutoEnableBySecrets(manifest, {});

			expect(result.shouldEnable).toBe(false);
			expect(result.missing).toContain("OPENAI_API_KEY");
		});

		it("should not enable plugin when required secrets are empty", () => {
			const manifest: PluginManifest = {
				id: "plugin-discord",
				requiredSecrets: ["DISCORD_BOT_TOKEN"],
			};

			const result = shouldAutoEnableBySecrets(manifest, {
				DISCORD_BOT_TOKEN: "",
			});

			expect(result.shouldEnable).toBe(false);
			expect(result.missing).toContain("DISCORD_BOT_TOKEN");
		});

		it("should enable plugin with no required secrets", () => {
			const manifest: PluginManifest = {
				id: "plugin-core",
				requiredSecrets: [],
			};

			const result = shouldAutoEnableBySecrets(manifest, {});

			expect(result.shouldEnable).toBe(true);
		});

		it("should resolve secret key aliases", () => {
			const manifest: PluginManifest = {
				id: "plugin-discord",
				requiredSecrets: ["DISCORD_TOKEN"], // Alias for DISCORD_BOT_TOKEN
			};

			const result = shouldAutoEnableBySecrets(manifest, {
				DISCORD_BOT_TOKEN: "valid-token",
			});

			expect(result.shouldEnable).toBe(true);
		});

		it("should require all secrets for multiple requirements", () => {
			const manifest: PluginManifest = {
				id: "plugin-twitter",
				requiredSecrets: ["TWITTER_USERNAME", "TWITTER_PASSWORD"],
			};

			// Only one secret present
			const result1 = shouldAutoEnableBySecrets(manifest, {
				TWITTER_USERNAME: "myuser",
			});
			expect(result1.shouldEnable).toBe(false);
			expect(result1.missing).toContain("TWITTER_PASSWORD");

			// Both secrets present
			const result2 = shouldAutoEnableBySecrets(manifest, {
				TWITTER_USERNAME: "myuser",
				TWITTER_PASSWORD: "mypass",
			});
			expect(result2.shouldEnable).toBe(true);
		});
	});

	describe("Auto-Enable by Config", () => {
		it("should enable plugins based on config settings", () => {
			const manifests: PluginManifest[] = [
				{ id: "plugin-a", requiredSecrets: [] },
				{ id: "plugin-b", requiredSecrets: [] },
			];

			const results = autoEnablePlugins(manifests, {
				secrets: {},
				allow: ["plugin-a"],
			});

			expect(results.find((r) => r.pluginId === "plugin-a")?.enabled).toBe(
				true,
			);
			expect(results.find((r) => r.pluginId === "plugin-b")?.enabled).toBe(
				false,
			);
		});

		it("should handle wildcard allow", () => {
			const manifests: PluginManifest[] = [
				{ id: "plugin-a", requiredSecrets: [] },
				{ id: "plugin-b", requiredSecrets: [] },
			];

			const results = autoEnablePlugins(manifests, {
				secrets: {},
				allow: ["*"],
			});

			expect(results.every((r) => r.enabled)).toBe(true);
		});
	});

	describe("Allow/Deny Filtering", () => {
		it("should deny explicitly denied plugins", () => {
			const result = isPluginAllowed("plugin-test", undefined, ["plugin-test"]);

			expect(result.allowed).toBe(false);
			expect(result.reason).toBe("Explicitly denied");
		});

		it("should deny all plugins with wildcard deny", () => {
			const result = isPluginAllowed("plugin-test", undefined, ["*"]);

			expect(result.allowed).toBe(false);
			expect(result.reason).toBe("Explicitly denied");
		});

		it("should allow explicitly allowed plugins", () => {
			const result = isPluginAllowed("plugin-test", ["plugin-test"], undefined);

			expect(result.allowed).toBe(true);
			expect(result.reason).toBe("Explicitly allowed");
		});

		it("should deny plugins not in allow list", () => {
			const result = isPluginAllowed(
				"plugin-test",
				["plugin-other"],
				undefined,
			);

			expect(result.allowed).toBe(false);
			expect(result.reason).toBe("Not in allow list");
		});

		it("should allow all plugins with wildcard allow", () => {
			const result = isPluginAllowed("plugin-test", ["*"], undefined);

			expect(result.allowed).toBe(true);
			expect(result.reason).toBe("Explicitly allowed");
		});

		it("should have deny take precedence over allow", () => {
			const result = isPluginAllowed(
				"plugin-test",
				["plugin-test"],
				["plugin-test"],
			);

			expect(result.allowed).toBe(false);
			expect(result.reason).toBe("Explicitly denied");
		});

		it("should allow plugins when no lists specified", () => {
			const result = isPluginAllowed("plugin-test", undefined, undefined);

			expect(result.allowed).toBe(true);
			expect(result.reason).toBe("No restrictions");
		});

		it("should allow plugins with empty lists", () => {
			const result = isPluginAllowed("plugin-test", [], []);

			expect(result.allowed).toBe(true);
			expect(result.reason).toBe("No restrictions");
		});
	});

	describe("Full Auto-Enable Flow", () => {
		it("should auto-enable plugins with met requirements", () => {
			const manifests: PluginManifest[] = [
				{ id: "plugin-openai", requiredSecrets: ["OPENAI_API_KEY"] },
				{ id: "plugin-discord", requiredSecrets: ["DISCORD_BOT_TOKEN"] },
				{ id: "plugin-core", requiredSecrets: [] },
			];

			const results = autoEnablePlugins(manifests, {
				secrets: {
					OPENAI_API_KEY: "sk-test12345678901234567890",
				},
			});

			expect(results.find((r) => r.pluginId === "plugin-openai")?.enabled).toBe(
				true,
			);
			expect(
				results.find((r) => r.pluginId === "plugin-discord")?.enabled,
			).toBe(false);
			expect(results.find((r) => r.pluginId === "plugin-core")?.enabled).toBe(
				true,
			);
		});

		it("should respect deny list over secrets", () => {
			const manifests: PluginManifest[] = [
				{ id: "plugin-openai", requiredSecrets: ["OPENAI_API_KEY"] },
			];

			const results = autoEnablePlugins(manifests, {
				secrets: { OPENAI_API_KEY: "sk-test12345678901234567890" },
				deny: ["plugin-openai"],
			});

			expect(results[0].enabled).toBe(false);
			expect(results[0].reason).toBe("Explicitly denied");
		});

		it("should include missing secrets in result", () => {
			const manifests: PluginManifest[] = [
				{
					id: "plugin-twitter",
					requiredSecrets: ["TWITTER_USERNAME", "TWITTER_PASSWORD"],
				},
			];

			const results = autoEnablePlugins(manifests, {
				secrets: { TWITTER_USERNAME: "myuser" },
			});

			expect(results[0].enabled).toBe(false);
			expect(results[0].missingSecrets).toContain("TWITTER_PASSWORD");
		});
	});

	describe("Model Provider Auto-Enable", () => {
		it("should return provider plugin when secret is present", () => {
			const plugins = getProviderPlugins("openai", {
				OPENAI_API_KEY: "sk-test",
			});

			expect(plugins).toContain("plugin-openai");
		});

		it("should return empty array when secret is missing", () => {
			const plugins = getProviderPlugins("openai", {});

			expect(plugins).toHaveLength(0);
		});

		it("should handle all model providers", () => {
			const providers = Object.keys(MODEL_PROVIDER_SECRETS);

			for (const provider of providers) {
				const secretKey = MODEL_PROVIDER_SECRETS[provider];
				const plugins = getProviderPlugins(provider, {
					[secretKey]: "test-value",
				});

				expect(plugins).toContain(`plugin-${provider}`);
			}
		});
	});

	describe("Channel Auto-Enable", () => {
		it("should return channel plugin when all secrets are present", () => {
			const plugins = getChannelPlugins("discord", {
				DISCORD_BOT_TOKEN: "valid-token",
			});

			expect(plugins).toContain("plugin-discord");
		});

		it("should return empty array when secrets are missing", () => {
			const plugins = getChannelPlugins("discord", {});

			expect(plugins).toHaveLength(0);
		});

		it("should require all secrets for channels with multiple requirements", () => {
			// Slack requires both bot token and app token
			const pluginsPartial = getChannelPlugins("slack", {
				SLACK_BOT_TOKEN: "xoxb-token",
			});
			expect(pluginsPartial).toHaveLength(0);

			const pluginsFull = getChannelPlugins("slack", {
				SLACK_BOT_TOKEN: "xoxb-token",
				SLACK_APP_TOKEN: "xapp-token",
			});
			expect(pluginsFull).toContain("plugin-slack");
		});

		it("should return empty array for unknown channels", () => {
			const plugins = getChannelPlugins("unknown", {
				SOME_TOKEN: "value",
			});

			expect(plugins).toHaveLength(0);
		});
	});

	describe("Edge Cases", () => {
		it("should handle whitespace-only secret values", () => {
			const manifest: PluginManifest = {
				id: "plugin-test",
				requiredSecrets: ["TEST_KEY"],
			};

			const result = shouldAutoEnableBySecrets(manifest, {
				TEST_KEY: "   ",
			});

			expect(result.shouldEnable).toBe(false);
		});

		it("should handle undefined manifest fields", () => {
			const manifest: PluginManifest = {
				id: "plugin-test",
				// requiredSecrets is undefined
			};

			const result = shouldAutoEnableBySecrets(manifest, {});

			expect(result.shouldEnable).toBe(true);
		});

		it("should handle empty plugin list", () => {
			const results = autoEnablePlugins([], { secrets: {} });

			expect(results).toHaveLength(0);
		});

		it("should handle plugins with same required secrets", () => {
			const manifests: PluginManifest[] = [
				{ id: "plugin-a", requiredSecrets: ["SHARED_KEY"] },
				{ id: "plugin-b", requiredSecrets: ["SHARED_KEY"] },
			];

			const results = autoEnablePlugins(manifests, {
				secrets: { SHARED_KEY: "value" },
			});

			expect(results.every((r) => r.enabled)).toBe(true);
		});
	});
});
