/**
 * Plugin Discovery Tests
 *
 * Tests for plugin discovery in workspace, manifest loading,
 * and manifest registry queries.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	deriveIdHint,
	discoverPlugins,
	getPackageManifestMetadata,
	isExtensionFile,
	readPackageManifest,
	resolveUserPath,
} from "../plugins/discovery";

import {
	clearManifestRegistryCache,
	getPluginManifestById,
	getPluginsByChannel,
	getPluginsByKind,
	getPluginsByProvider,
	loadPluginManifest,
	loadPluginManifestRegistry,
	normalizePluginsConfig,
	PLUGIN_MANIFEST_FILENAME,
} from "../plugins/manifest-registry";

import type { PluginManifest } from "../types/plugin-manifest";

// ============================================================================
// Test Utilities
// ============================================================================

let testDir: string;

function createTestDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "plugin-discovery-test-"));
}

function cleanupTestDir(dir: string): void {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

function createPluginDir(
	parentDir: string,
	pluginName: string,
	options: {
		hasPackageJson?: boolean;
		packageName?: string;
		hasManifest?: boolean;
		manifestId?: string;
		hasIndexTs?: boolean;
		hasIndexJs?: boolean;
		extensions?: string[];
		elizaosMetadata?: Record<string, unknown>;
	} = {},
): string {
	const pluginDir = path.join(parentDir, pluginName);
	fs.mkdirSync(pluginDir, { recursive: true });

	if (options.hasPackageJson !== false) {
		const packageJson: Record<string, unknown> = {
			name: options.packageName || `@elizaos/plugin-${pluginName}`,
			version: "1.0.0",
			description: `Test plugin ${pluginName}`,
		};

		if (options.elizaosMetadata) {
			packageJson.elizaos = options.elizaosMetadata;
		}

		if (options.extensions) {
			packageJson.elizaos = {
				...((packageJson.elizaos as Record<string, unknown>) || {}),
				extensions: options.extensions,
			};
		}

		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify(packageJson, null, 2),
		);
	}

	if (options.hasManifest) {
		const manifest = {
			id: options.manifestId || pluginName,
			configSchema: {},
		};
		fs.writeFileSync(
			path.join(pluginDir, PLUGIN_MANIFEST_FILENAME),
			JSON.stringify(manifest, null, 2),
		);
	}

	if (options.hasIndexTs) {
		fs.writeFileSync(
			path.join(pluginDir, "index.ts"),
			"export const plugin = {};",
		);
	}

	if (options.hasIndexJs) {
		fs.writeFileSync(path.join(pluginDir, "index.js"), "module.exports = {};");
	}

	return pluginDir;
}

// ============================================================================
// Tests
// ============================================================================

describe("Plugin Discovery", () => {
	beforeEach(() => {
		testDir = createTestDir();
		clearManifestRegistryCache();
	});

	afterEach(() => {
		cleanupTestDir(testDir);
	});

	describe("discoverPlugins()", () => {
		it("should discover plugins in workspace plugins directory", () => {
			const workspaceDir = testDir;
			const pluginsDir = path.join(workspaceDir, "plugins");
			fs.mkdirSync(pluginsDir, { recursive: true });

			createPluginDir(pluginsDir, "test-plugin", {
				hasIndexTs: true,
				hasManifest: true,
			});

			const result = discoverPlugins({ workspaceDir });

			expect(result.candidates.length).toBeGreaterThan(0);
			expect(result.candidates.some((c) => c.idHint === "test-plugin")).toBe(
				true,
			);
		});

		it("should discover plugins in extensions directory", () => {
			const workspaceDir = testDir;
			const extensionsDir = path.join(workspaceDir, "extensions");
			fs.mkdirSync(extensionsDir, { recursive: true });

			createPluginDir(extensionsDir, "my-extension", {
				hasIndexTs: true,
			});

			const result = discoverPlugins({ workspaceDir });

			const found = result.candidates.some(
				(c) => c.idHint === "my-extension" && c.origin === "workspace",
			);
			expect(found).toBe(true);
		});

		it("should discover plugins from extra paths", () => {
			const customDir = path.join(testDir, "custom-plugins");
			fs.mkdirSync(customDir, { recursive: true });

			createPluginDir(customDir, "custom-plugin", {
				hasIndexTs: true,
			});

			const result = discoverPlugins({
				extraPaths: [customDir],
			});

			const found = result.candidates.some(
				(c) => c.idHint === "custom-plugin" && c.origin === "config",
			);
			expect(found).toBe(true);
		});

		it("should handle direct file paths in extraPaths", () => {
			const filePath = path.join(testDir, "direct-plugin.ts");
			fs.writeFileSync(filePath, "export const plugin = {};");

			const result = discoverPlugins({
				extraPaths: [filePath],
			});

			const found = result.candidates.some((c) => c.idHint === "direct-plugin");
			expect(found).toBe(true);
		});

		it("should report diagnostics for missing paths", () => {
			const result = discoverPlugins({
				extraPaths: ["/non/existent/path"],
			});

			expect(result.diagnostics.length).toBeGreaterThan(0);
			expect(result.diagnostics.some((d) => d.level === "error")).toBe(true);
		});

		it("should deduplicate plugins by resolved path", () => {
			const pluginsDir = path.join(testDir, "plugins");
			fs.mkdirSync(pluginsDir, { recursive: true });

			createPluginDir(pluginsDir, "dedup-test", {
				hasIndexTs: true,
			});

			// Discover with same path listed twice via extraPaths
			const result = discoverPlugins({
				workspaceDir: testDir,
				extraPaths: [path.join(pluginsDir, "dedup-test")],
			});

			const matches = result.candidates.filter(
				(c) => c.idHint === "dedup-test",
			);
			expect(matches.length).toBe(1);
		});
	});

	describe("isExtensionFile()", () => {
		it("should accept .ts files", () => {
			expect(isExtensionFile("plugin.ts")).toBe(true);
			expect(isExtensionFile("/path/to/plugin.ts")).toBe(true);
		});

		it("should accept .js files", () => {
			expect(isExtensionFile("plugin.js")).toBe(true);
		});

		it("should accept .mts, .cts, .mjs, .cjs files", () => {
			expect(isExtensionFile("plugin.mts")).toBe(true);
			expect(isExtensionFile("plugin.cts")).toBe(true);
			expect(isExtensionFile("plugin.mjs")).toBe(true);
			expect(isExtensionFile("plugin.cjs")).toBe(true);
		});

		it("should reject .d.ts declaration files", () => {
			expect(isExtensionFile("plugin.d.ts")).toBe(false);
			expect(isExtensionFile("/path/to/types.d.ts")).toBe(false);
		});

		it("should reject non-extension files", () => {
			expect(isExtensionFile("readme.md")).toBe(false);
			expect(isExtensionFile("config.json")).toBe(false);
			expect(isExtensionFile("styles.css")).toBe(false);
		});
	});

	describe("readPackageManifest()", () => {
		it("should read valid package.json", () => {
			const pluginDir = createPluginDir(testDir, "pkg-test", {
				packageName: "@elizaos/plugin-test",
			});

			const manifest = readPackageManifest(pluginDir);

			expect(manifest).not.toBeNull();
			expect(manifest?.name).toBe("@elizaos/plugin-test");
			expect(manifest?.version).toBe("1.0.0");
		});

		it("should return null for missing package.json", () => {
			const emptyDir = path.join(testDir, "empty");
			fs.mkdirSync(emptyDir, { recursive: true });

			const manifest = readPackageManifest(emptyDir);

			expect(manifest).toBeNull();
		});

		it("should return null for invalid JSON", () => {
			const invalidDir = path.join(testDir, "invalid");
			fs.mkdirSync(invalidDir, { recursive: true });
			fs.writeFileSync(
				path.join(invalidDir, "package.json"),
				"{ invalid json }",
			);

			const manifest = readPackageManifest(invalidDir);

			expect(manifest).toBeNull();
		});
	});

	describe("getPackageManifestMetadata()", () => {
		it("should extract elizaos metadata", () => {
			const manifest = {
				name: "test",
				version: "1.0.0",
				elizaos: {
					extensions: ["./src/index.ts"],
				},
			};

			const metadata = getPackageManifestMetadata(manifest);

			expect(metadata).toBeDefined();
			expect(metadata?.extensions).toContain("./src/index.ts");
		});

		it("should return undefined for no metadata", () => {
			const manifest = {
				name: "test",
				version: "1.0.0",
			};

			const metadata = getPackageManifestMetadata(manifest);

			expect(metadata).toBeUndefined();
		});
	});

	describe("deriveIdHint()", () => {
		it("should derive ID from scoped package name", () => {
			expect(
				deriveIdHint({
					filePath: "index.ts",
					packageName: "@elizaos/plugin-discord",
					hasMultipleExtensions: false,
				}),
			).toBe("discord");
		});

		it("should strip plugin- prefix", () => {
			expect(
				deriveIdHint({
					filePath: "index.ts",
					packageName: "plugin-telegram",
					hasMultipleExtensions: false,
				}),
			).toBe("telegram");
		});

		it("should strip -plugin suffix", () => {
			expect(
				deriveIdHint({
					filePath: "index.ts",
					packageName: "discord-plugin",
					hasMultipleExtensions: false,
				}),
			).toBe("discord");
		});

		it("should use file basename for multiple extensions", () => {
			expect(
				deriveIdHint({
					filePath: "src/commands.ts",
					packageName: "@elizaos/plugin-discord",
					hasMultipleExtensions: true,
				}),
			).toBe("discord/commands");
		});

		it("should use file basename when no package name", () => {
			expect(
				deriveIdHint({
					filePath: "/path/to/my-plugin.ts",
					hasMultipleExtensions: false,
				}),
			).toBe("my-plugin");
		});
	});

	describe("resolveUserPath()", () => {
		it("should expand tilde to home directory", () => {
			const resolved = resolveUserPath("~/plugins");
			expect(resolved).toBe(path.join(os.homedir(), "plugins"));
		});

		it("should handle paths starting with ~", () => {
			const resolved = resolveUserPath("~plugins");
			expect(resolved).toBe(path.join(os.homedir(), "plugins"));
		});

		it("should resolve relative paths", () => {
			const resolved = resolveUserPath("./plugins");
			expect(path.isAbsolute(resolved)).toBe(true);
		});

		it("should preserve absolute paths", () => {
			const absolute = "/absolute/path/to/plugins";
			expect(resolveUserPath(absolute)).toBe(absolute);
		});
	});
});

describe("Plugin Manifest Registry", () => {
	beforeEach(() => {
		testDir = createTestDir();
		clearManifestRegistryCache();
	});

	afterEach(() => {
		cleanupTestDir(testDir);
	});

	describe("loadPluginManifest()", () => {
		it("should load valid manifest", () => {
			const pluginDir = createPluginDir(testDir, "valid-manifest", {
				hasManifest: true,
				manifestId: "valid-plugin",
			});

			const result = loadPluginManifest(pluginDir);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.manifest.id).toBe("valid-plugin");
			}
		});

		it("should return error for missing manifest", () => {
			const emptyDir = path.join(testDir, "no-manifest");
			fs.mkdirSync(emptyDir, { recursive: true });

			const result = loadPluginManifest(emptyDir);

			expect(result.ok).toBe(false);
			expect(result.error).toContain("not found");
		});

		it("should return error for invalid JSON", () => {
			const invalidDir = path.join(testDir, "invalid-json");
			fs.mkdirSync(invalidDir, { recursive: true });
			fs.writeFileSync(
				path.join(invalidDir, PLUGIN_MANIFEST_FILENAME),
				"{ invalid }",
			);

			const result = loadPluginManifest(invalidDir);

			expect(result.ok).toBe(false);
			expect(result.error).toContain("parse");
		});

		it("should return error for missing id field", () => {
			const noIdDir = path.join(testDir, "no-id");
			fs.mkdirSync(noIdDir, { recursive: true });
			fs.writeFileSync(
				path.join(noIdDir, PLUGIN_MANIFEST_FILENAME),
				JSON.stringify({ configSchema: {} }),
			);

			const result = loadPluginManifest(noIdDir);

			expect(result.ok).toBe(false);
			expect(result.error).toContain("id");
		});

		it("should return error for missing configSchema", () => {
			const noSchemaDir = path.join(testDir, "no-schema");
			fs.mkdirSync(noSchemaDir, { recursive: true });
			fs.writeFileSync(
				path.join(noSchemaDir, PLUGIN_MANIFEST_FILENAME),
				JSON.stringify({ id: "test" }),
			);

			const result = loadPluginManifest(noSchemaDir);

			expect(result.ok).toBe(false);
			expect(result.error).toContain("configSchema");
		});

		it("should load optional fields", () => {
			const fullDir = path.join(testDir, "full-manifest");
			fs.mkdirSync(fullDir, { recursive: true });
			fs.writeFileSync(
				path.join(fullDir, PLUGIN_MANIFEST_FILENAME),
				JSON.stringify({
					id: "full-plugin",
					configSchema: {},
					name: "Full Plugin",
					description: "A full plugin",
					version: "1.0.0",
					kind: "channel",
					channels: ["discord"],
					providers: ["openai"],
					requiredSecrets: ["DISCORD_BOT_TOKEN"],
					optionalSecrets: ["DISCORD_APPLICATION_ID"],
				}),
			);

			const result = loadPluginManifest(fullDir);

			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.manifest.name).toBe("Full Plugin");
				expect(result.manifest.kind).toBe("channel");
				expect(result.manifest.channels).toContain("discord");
				expect(result.manifest.providers).toContain("openai");
				expect(result.manifest.requiredSecrets).toContain("DISCORD_BOT_TOKEN");
			}
		});
	});

	describe("loadPluginManifestRegistry()", () => {
		it("should load registry from discovered plugins", () => {
			const pluginsDir = path.join(testDir, "plugins");
			fs.mkdirSync(pluginsDir, { recursive: true });

			createPluginDir(pluginsDir, "registry-test", {
				hasManifest: true,
				manifestId: "registry-plugin",
				hasIndexTs: true,
			});

			const registry = loadPluginManifestRegistry({
				workspaceDir: testDir,
			});

			expect(registry.plugins.length).toBeGreaterThan(0);
		});

		it("should use cached registry", () => {
			const pluginsDir = path.join(testDir, "plugins");
			fs.mkdirSync(pluginsDir, { recursive: true });

			createPluginDir(pluginsDir, "cache-test", {
				hasManifest: true,
				manifestId: "cached-plugin",
				hasIndexTs: true,
			});

			// First call
			const registry1 = loadPluginManifestRegistry({
				workspaceDir: testDir,
				cache: true,
			});

			// Second call should use cache
			const registry2 = loadPluginManifestRegistry({
				workspaceDir: testDir,
				cache: true,
			});

			// References should be the same (cached)
			expect(registry1).toBe(registry2);
		});

		it("should bypass cache when disabled", () => {
			clearManifestRegistryCache();

			const pluginsDir = path.join(testDir, "plugins");
			fs.mkdirSync(pluginsDir, { recursive: true });

			createPluginDir(pluginsDir, "no-cache-test", {
				hasManifest: true,
				manifestId: "no-cache-plugin",
				hasIndexTs: true,
			});

			const registry1 = loadPluginManifestRegistry({
				workspaceDir: testDir,
				cache: false,
			});

			const registry2 = loadPluginManifestRegistry({
				workspaceDir: testDir,
				cache: false,
			});

			// Different objects (not cached)
			expect(registry1).not.toBe(registry2);
		});
	});

	describe("Registry Queries", () => {
		it("should get plugin by ID", () => {
			const registry = {
				plugins: [
					{ id: "plugin-a", name: "Plugin A" } as unknown as PluginManifest,
					{ id: "plugin-b", name: "Plugin B" } as unknown as PluginManifest,
				],
				diagnostics: [],
			};

			const plugin = getPluginManifestById(registry, "plugin-a");

			expect(plugin).toBeDefined();
			expect(plugin?.name).toBe("Plugin A");
		});

		it("should return undefined for unknown plugin ID", () => {
			const registry = {
				plugins: [{ id: "plugin-a" } as unknown as PluginManifest],
				diagnostics: [],
			};

			const plugin = getPluginManifestById(registry, "unknown");

			expect(plugin).toBeUndefined();
		});

		it("should get plugins by kind", () => {
			const registry = {
				plugins: [
					{ id: "channel-1", kind: "channel" } as unknown as PluginManifest,
					{ id: "provider-1", kind: "provider" } as unknown as PluginManifest,
					{ id: "channel-2", kind: "channel" } as unknown as PluginManifest,
				],
				diagnostics: [],
			};

			const channels = getPluginsByKind(registry, "channel");

			expect(channels).toHaveLength(2);
			expect(channels.every((p) => p.kind === "channel")).toBe(true);
		});

		it("should get plugins by channel", () => {
			const registry = {
				plugins: [
					{
						id: "discord-plugin",
						channels: ["discord"],
					} as unknown as PluginManifest,
					{
						id: "telegram-plugin",
						channels: ["telegram"],
					} as unknown as PluginManifest,
					{
						id: "multi-plugin",
						channels: ["discord", "slack"],
					} as unknown as PluginManifest,
				],
				diagnostics: [],
			};

			const discordPlugins = getPluginsByChannel(registry, "discord");

			expect(discordPlugins).toHaveLength(2);
			expect(discordPlugins.some((p) => p.id === "discord-plugin")).toBe(true);
			expect(discordPlugins.some((p) => p.id === "multi-plugin")).toBe(true);
		});

		it("should get plugins by provider", () => {
			const registry = {
				plugins: [
					{
						id: "openai-plugin",
						providers: ["openai"],
					} as unknown as PluginManifest,
					{
						id: "anthropic-plugin",
						providers: ["anthropic"],
					} as unknown as PluginManifest,
					{
						id: "multi-plugin",
						providers: ["openai", "groq"],
					} as unknown as PluginManifest,
				],
				diagnostics: [],
			};

			const openaiPlugins = getPluginsByProvider(registry, "openai");

			expect(openaiPlugins).toHaveLength(2);
		});
	});

	describe("normalizePluginsConfig()", () => {
		it("should provide defaults for undefined config", () => {
			const config = normalizePluginsConfig(undefined);

			expect(config.allow).toEqual([]);
			expect(config.deny).toEqual([]);
			expect(config.loadPaths).toEqual([]);
			expect(config.entries).toEqual({});
			expect(config.slots).toEqual({});
		});

		it("should preserve provided values", () => {
			const config = normalizePluginsConfig({
				allow: ["plugin-a"],
				deny: ["plugin-b"],
				loadPaths: ["/custom/path"],
				entries: { "plugin-a": { enabled: true } },
				slots: { memory: "plugin-sql" },
			});

			expect(config.allow).toContain("plugin-a");
			expect(config.deny).toContain("plugin-b");
			expect(config.loadPaths).toContain("/custom/path");
			expect(config.entries["plugin-a"].enabled).toBe(true);
			expect(config.slots.memory).toBe("plugin-sql");
		});

		it("should handle partial config", () => {
			const config = normalizePluginsConfig({
				allow: ["plugin-a"],
				// Other fields undefined
			});

			expect(config.allow).toContain("plugin-a");
			expect(config.deny).toEqual([]);
			expect(config.loadPaths).toEqual([]);
		});
	});
});
