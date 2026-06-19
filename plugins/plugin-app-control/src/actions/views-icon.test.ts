/**
 * Tests for the VIEWS `icon` sub-mode: intent detection, target extraction, and
 * the direct hero-asset regeneration (no coding agent).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const coreMock = vi.hoisted(() => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	resolveServerOnlyPort: vi.fn(() => 3456),
	hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/core", () => coreMock);

import type { ViewSummary } from "./views-client.js";
import {
	extractIconTarget,
	isViewIconRequest,
	runViewsIcon,
} from "./views-icon.js";

function message(text: string) {
	return {
		entityId: "user-1",
		roomId: "room-1",
		agentId: "agent-1",
		content: { text },
	} as never;
}

describe("isViewIconRequest", () => {
	it("matches mutate-verb + icon-noun phrasings", () => {
		expect(isViewIconRequest("regenerate the wallet view icon")).toBe(true);
		expect(isViewIconRequest("change the calendar image")).toBe(true);
		expect(isViewIconRequest("give relationships a new hero")).toBe(true);
		expect(isViewIconRequest("make a logo for the goals view")).toBe(true);
	});

	it("matches an explicit action=icon option even without an icon noun", () => {
		expect(isViewIconRequest("the wallet view", { action: "icon" })).toBe(true);
	});

	it("does not match navigation or unrelated requests", () => {
		expect(isViewIconRequest("show the calendar")).toBe(false);
		expect(isViewIconRequest("open the wallet view")).toBe(false);
		expect(isViewIconRequest("list views")).toBe(false);
		// 'icon' noun but no mutate verb.
		expect(isViewIconRequest("which view has the nicest icon?")).toBe(false);
	});
});

describe("extractIconTarget", () => {
	it("prefers an explicit option", () => {
		expect(
			extractIconTarget(message("regenerate the icon"), { view: "wallet" }),
		).toBe("wallet");
	});

	it("strips verbs, icon nouns, and filler to recover the view name", () => {
		expect(
			extractIconTarget(message("regenerate the wallet view icon"), undefined),
		).toBe("wallet");
		expect(
			extractIconTarget(
				message("give the social alpha view a new image"),
				undefined,
			),
		).toBe("social alpha");
	});
});

describe("runViewsIcon", () => {
	let repoRoot: string;
	let pluginDir: string;

	const views: ViewSummary[] = [
		{
			id: "foo",
			label: "Foo",
			pluginName: "@elizaos/plugin-foo",
			available: true,
			icon: "Calendar",
			tags: ["calendar"],
		},
	];

	beforeEach(async () => {
		repoRoot = await mkdtemp(path.join(tmpdir(), "views-icon-"));
		pluginDir = path.join(repoRoot, "plugins", "plugin-foo");
		await mkdir(pluginDir, { recursive: true });
		await writeFile(
			path.join(pluginDir, "package.json"),
			`${JSON.stringify({ name: "@elizaos/plugin-foo", files: ["dist"] }, null, 2)}\n`,
			"utf8",
		);
	});

	afterEach(async () => {
		await rm(repoRoot, { recursive: true, force: true });
	});

	it("writes a branded hero SVG and publishes assets in package.json", async () => {
		const callback = vi.fn(async () => []);
		const result = await runViewsIcon({
			runtime: { agentId: "agent-1" } as never,
			message: message("regenerate the foo view icon"),
			views,
			callback,
			repoRoot,
		});

		expect(result.success).toBe(true);
		const heroPath = path.join(pluginDir, "assets", "hero.svg");
		const svg = await readFile(heroPath, "utf8");
		expect(svg).toContain('viewBox="0 0 1024 1024"');
		expect(svg).toContain(">Foo<");

		const pkg = JSON.parse(
			await readFile(path.join(pluginDir, "package.json"), "utf8"),
		);
		expect(pkg.files).toContain("assets");
	});

	it("overwrites and removes a higher-priority hero variant", async () => {
		await mkdir(path.join(pluginDir, "assets"), { recursive: true });
		const pngPath = path.join(pluginDir, "assets", "hero.png");
		await writeFile(pngPath, "not-a-real-png", "utf8");

		const result = await runViewsIcon({
			runtime: { agentId: "agent-1" } as never,
			message: message("regenerate the foo view icon"),
			views,
			callback: vi.fn(async () => []),
			repoRoot,
		});

		expect(result.success).toBe(true);
		// The png must be gone so the freshly generated svg is the one served.
		await expect(readFile(pngPath, "utf8")).rejects.toThrow();
		const svg = await readFile(
			path.join(pluginDir, "assets", "hero.svg"),
			"utf8",
		);
		expect(svg).toContain("<svg");
	});

	it("reports when the target view does not exist", async () => {
		const result = await runViewsIcon({
			runtime: { agentId: "agent-1" } as never,
			message: message("regenerate the nonexistent view icon"),
			views,
			callback: vi.fn(async () => []),
			repoRoot,
		});
		expect(result.success).toBe(false);
	});
});
