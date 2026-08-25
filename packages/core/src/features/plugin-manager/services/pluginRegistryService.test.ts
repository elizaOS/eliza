/**
 * Exercises plugin-registry normalization, lookup, search, filtering, refresh,
 * local overrides, and cloning against real service behavior. Network input is
 * supplied through deterministic Response objects and cloning uses a local Git repository.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ElizaError } from "../../../errors.ts";
import {
	clonePlugin,
	getAllPlugins,
	getPluginDetails,
	getRegistryEntry,
	listNonAppPlugins,
	loadRegistry,
	refreshRegistry,
	resetRegistryCache,
	searchNonAppPlugins,
	searchPluginsByContent,
} from "./pluginRegistryService.ts";

interface RegistryEntryOptions {
	repo?: string;
	description?: string;
	topics?: string[];
	stars?: number;
	v0?: string | null;
	v1?: string | null;
	v2?: string | null;
	supports?: { v0: boolean; v1: boolean; v2: boolean };
	kind?: string;
	displayName?: string;
}

function registryEntry(options: RegistryEntryOptions = {}) {
	const repo = options.repo ?? "elizaOS/plugin-example";
	const v2 = options.v2 === undefined ? "2.0.0" : options.v2;
	return {
		git: {
			repo,
			v0: { version: options.v0 ?? null, branch: "legacy" },
			v1: { version: options.v1 ?? null, branch: "next" },
			v2: { version: v2, branch: "main" },
		},
		npm: {
			repo: `@elizaos/${repo.split("/").at(-1)}`,
			v0: options.v0 ?? null,
			v1: options.v1 ?? null,
			v2,
			v0CoreRange: null,
			v1CoreRange: "^1.0.0",
			v2CoreRange: "^2.0.0",
		},
		supports: options.supports ?? { v0: false, v1: true, v2: true },
		description: options.description ?? "Example plugin",
		homepage: null,
		topics: options.topics ?? [],
		stargazers_count: options.stars ?? 0,
		language: "TypeScript",
		kind: options.kind,
		app: options.displayName
			? { displayName: options.displayName, category: "productivity" }
			: undefined,
	};
}

function registryResponse(
	registry: Record<string, ReturnType<typeof registryEntry>>,
	apps?: Record<string, ReturnType<typeof registryEntry>>,
): Response {
	return new Response(
		JSON.stringify({
			lastUpdatedAt: "2026-08-23T00:00:00Z",
			registry,
			apps,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

function stubRegistry(
	registry: Record<string, ReturnType<typeof registryEntry>>,
	apps?: Record<string, ReturnType<typeof registryEntry>>,
) {
	const fetchSpy = vi.fn(() =>
		Promise.resolve(registryResponse(registry, apps)),
	);
	vi.stubGlobal("fetch", fetchSpy);
	return fetchSpy;
}

const originalCwd = process.cwd();
let temporaryCwd: string;

beforeEach(() => {
	temporaryCwd = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "plugin-registry-test-")),
	);
	process.chdir(temporaryCwd);
	resetRegistryCache();
});

afterEach(() => {
	process.chdir(originalCwd);
	fs.rmSync(temporaryCwd, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	resetRegistryCache();
});

describe("pluginRegistryService", () => {
	it("normalizes registry and app entries while preserving insertion order", async () => {
		stubRegistry(
			{
				"@elizaos/legacy": registryEntry({
					repo: "community/plugin-legacy",
					v0: "0.9.0",
					v1: null,
					v2: null,
					supports: { v0: true, v1: false, v2: false },
				}),
			},
			{
				"@elizaos/calendar-app": registryEntry({
					displayName: "Calendar",
				}),
			},
		);

		const plugins = await loadRegistry();

		expect([...plugins.keys()]).toEqual([
			"@elizaos/legacy",
			"@elizaos/calendar-app",
		]);
		expect(plugins.get("@elizaos/legacy")).toMatchObject({
			gitRepo: "community/plugin-legacy",
			gitUrl: "https://github.com/community/plugin-legacy.git",
			git: { v0Branch: "legacy", v1Branch: "next", v2Branch: "main" },
			npm: { v0Version: "0.9.0", v1Version: null, v2Version: null },
		});
		expect(plugins.get("@elizaos/calendar-app")).toMatchObject({
			kind: "app",
			displayName: "Calendar",
			category: "productivity",
		});
	});

	it("resolves exact, elizaOS-prefixed, and foreign-scoped bare names", async () => {
		stubRegistry({
			"@elizaos/alpha": registryEntry({ repo: "elizaOS/plugin-alpha" }),
			"@community/beta": registryEntry({ repo: "community/plugin-beta" }),
		});

		const exact = await getRegistryEntry("@elizaos/alpha");
		const prefixed = await getRegistryEntry("alpha");
		const bareFromScope = await getRegistryEntry("@another/beta");

		expect(prefixed).toBe(exact);
		expect(bareFromScope?.name).toBe("@community/beta");
		await expect(getRegistryEntry("missing")).resolves.toBeNull();
	});

	it("orders equal text matches by stars and normalizes tied scores", async () => {
		stubRegistry({
			"@elizaos/wallet-low": registryEntry({
				description: "Wallet connector",
				stars: 4,
			}),
			"@elizaos/wallet-high": registryEntry({
				description: "Wallet connector",
				stars: 40,
			}),
		});

		const results = await searchPluginsByContent("wallet");

		expect(results.map(({ name }) => name)).toEqual([
			"@elizaos/wallet-high",
			"@elizaos/wallet-low",
		]);
		expect(results.map(({ score }) => score)).toEqual([1, 1]);
	});

	it("combines exact, description, topic, term, and popularity scoring", async () => {
		stubRegistry({
			"@elizaos/search": registryEntry({
				description: "Search tools for semantic search",
				topics: ["search", "semantic-search"],
				stars: 1_001,
			}),
			"@elizaos/description-only": registryEntry({
				description: "Semantic search helper",
				stars: 100,
			}),
			"@elizaos/unrelated": registryEntry({ description: "Image tools" }),
		});

		const results = await searchPluginsByContent("semantic search", 1);

		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			name: "@elizaos/search",
			score: 1,
			version: "2.0.0",
			npmPackage: "@elizaos/plugin-example",
			repository: "https://github.com/elizaOS/plugin-example",
		});
	});

	it("returns an empty result for no match and a unit score for one match", async () => {
		stubRegistry({
			"@elizaos/calendar": registryEntry({ description: "Schedule events" }),
		});

		await expect(searchPluginsByContent("unmatched")).resolves.toEqual([]);
		await expect(searchPluginsByContent("calendar")).resolves.toMatchObject([
			{ name: "@elizaos/calendar", score: 1 },
		]);
	});

	it("converts version and runtime fallbacks into plugin metadata", async () => {
		stubRegistry({
			"@elizaos/v2": registryEntry({ repo: "owner/v2", v2: "2.1.0" }),
			"@elizaos/v1": registryEntry({
				repo: "owner/v1",
				v1: "1.5.0",
				v2: null,
				supports: { v0: false, v1: true, v2: false },
			}),
			"@elizaos/v0": registryEntry({
				repo: "owner/v0",
				v0: "0.8.0",
				v1: null,
				v2: null,
				supports: { v0: true, v1: false, v2: false },
			}),
			"@elizaos/unknown": registryEntry({
				repo: "owner/unknown",
				v0: null,
				v1: null,
				v2: null,
				supports: { v0: false, v1: false, v2: false },
			}),
		});

		const all = await getAllPlugins();

		expect(
			all.map(({ latestVersion, runtimeVersion }) => [
				latestVersion,
				runtimeVersion,
			]),
		).toEqual([
			["2.1.0", "v2"],
			["1.5.0", "v1"],
			["0.8.0", "v0"],
			["unknown", "v0"],
		]);
		expect(await getPluginDetails("v1")).toMatchObject({
			author: "owner",
			maintainer: "owner",
			repository: "https://github.com/owner/v1",
			versions: ["1.5.0"],
			categories: [],
		});
		await expect(getPluginDetails("missing")).resolves.toBeNull();
	});

	it("excludes apps and display-name plugins from legacy listing and search", async () => {
		stubRegistry({
			"@elizaos/legacy": registryEntry({ description: "Wallet legacy" }),
			"@elizaos/app-kind": registryEntry({
				description: "Wallet app",
				kind: "app",
			}),
			"@elizaos/app-display": registryEntry({
				description: "Wallet display",
				displayName: "Wallet Display",
			}),
		});

		expect((await listNonAppPlugins()).map(({ name }) => name)).toEqual([
			"@elizaos/legacy",
		]);
		expect(
			(await searchNonAppPlugins("wallet")).map(({ name }) => name),
		).toEqual(["@elizaos/legacy"]);
		await expect(searchNonAppPlugins("missing")).resolves.toEqual([]);
	});

	it("refreshes a cached registry and returns the replacement map", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				registryResponse({ "@elizaos/first": registryEntry() }),
			)
			.mockResolvedValueOnce(
				registryResponse({ "@elizaos/second": registryEntry() }),
			);
		vi.stubGlobal("fetch", fetchSpy);

		const first = await loadRegistry();
		const refreshed = await refreshRegistry();

		expect([...first.keys()]).toEqual(["@elizaos/first"]);
		expect([...refreshed.keys()]).toEqual(["@elizaos/second"]);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
	});

	it("loads local manifests over remote entries using local defaults", async () => {
		const pluginDir = path.join(temporaryCwd, "plugins", "plugin-local");
		fs.mkdirSync(pluginDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "elizaos.plugin.json"),
			JSON.stringify({
				id: "@elizaos/local",
				name: "Local Name",
				description: "Local description",
				version: "3.0.0",
				keywords: ["local"],
				app: { category: "tools", capabilities: ["offline"] },
			}),
		);
		stubRegistry({
			"@elizaos/local": registryEntry({ description: "Remote description" }),
		});

		const plugin = (await loadRegistry()).get("@elizaos/local");

		expect(plugin).toMatchObject({
			description: "Local description",
			displayName: "Local Name",
			gitRepo: "elizaos/plugin-local",
			gitUrl: "https://github.com/elizaos/plugin-local.git",
			topics: ["local"],
			capabilities: ["offline"],
			npm: { v1Version: "3.0.0", v2Version: "3.0.0" },
		});
	});

	it("reports an invalid local manifest with its path and parse cause", async () => {
		const pluginDir = path.join(temporaryCwd, "plugins", "broken");
		fs.mkdirSync(pluginDir, { recursive: true });
		const manifestPath = path.join(pluginDir, "elizaos.plugin.json");
		fs.writeFileSync(manifestPath, "{");
		stubRegistry({});

		const error = await loadRegistry().catch((cause: unknown) => cause);

		expect(error).toBeInstanceOf(ElizaError);
		expect(error).toMatchObject({
			code: "PLUGIN_REGISTRY_LOCAL_MANIFEST_INVALID",
			context: { pluginJsonPath: manifestPath },
			cause: expect.any(SyntaxError),
		});
	});

	it("returns a structured miss without creating a clone directory", async () => {
		stubRegistry({});

		await expect(clonePlugin("missing")).resolves.toEqual({
			success: false,
			error: 'Plugin "missing" not found in registry',
		});
		expect(fs.existsSync(path.join(temporaryCwd, "cloned-plugins"))).toBe(
			false,
		);
	});

	it("clones a local plugin branch and inspects its package metadata", async () => {
		const sourceRepo = path.join(temporaryCwd, "source-plugin");
		fs.mkdirSync(sourceRepo);
		execFileSync("git", ["init", "--initial-branch=main", sourceRepo]);
		execFileSync("git", [
			"-C",
			sourceRepo,
			"config",
			"user.email",
			"test@example.com",
		]);
		execFileSync("git", [
			"-C",
			sourceRepo,
			"config",
			"user.name",
			"Registry Test",
		]);
		fs.writeFileSync(
			path.join(sourceRepo, "package.json"),
			JSON.stringify({
				scripts: { test: "vitest run" },
				dependencies: { zod: "^4.0.0" },
			}),
		);
		execFileSync("git", ["-C", sourceRepo, "add", "package.json"]);
		execFileSync("git", ["-C", sourceRepo, "commit", "-m", "test fixture"]);

		const pluginDir = path.join(temporaryCwd, "plugins", "plugin-local-clone");
		fs.mkdirSync(pluginDir, { recursive: true });
		fs.writeFileSync(
			path.join(pluginDir, "elizaos.plugin.json"),
			JSON.stringify({
				id: "@elizaos/local-clone",
				repository: `file://${sourceRepo}`,
			}),
		);
		stubRegistry({});

		const result = await clonePlugin("local-clone");

		expect(result).toEqual({
			success: true,
			pluginName: "@elizaos/local-clone",
			localPath: path.join(temporaryCwd, "cloned-plugins", "local-clone"),
			hasTests: true,
			dependencies: { zod: "^4.0.0" },
		});
		expect(fs.existsSync(path.join(result.localPath ?? "", ".git"))).toBe(true);
	});
});
