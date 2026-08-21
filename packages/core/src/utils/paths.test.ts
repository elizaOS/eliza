/**
 * Unit tests for paths resolution and caching in packages/core/src/utils/paths.ts.
 * Exercises default directory resolution, environment variable overrides, fallback
 * env keys, whitespace trimming, empty string fallback, and cache resets.
 */
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getAllElizaPaths,
	getCharactersDir,
	getDatabaseDir,
	getDataDir,
	getGeneratedDir,
	getUploadsAgentsDir,
	getUploadsChannelsDir,
	resetPaths,
} from "./paths.js";
import { resolveStateDir } from "./state-dir.js";

describe("paths", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		resetPaths();
		delete process.env.ELIZA_DATA_DIR;
		delete process.env.ELIZA_DATABASE_DIR;
		delete process.env.PGLITE_DATA_DIR;
		delete process.env.ELIZA_DATA_DIR_CHARACTERS;
		delete process.env.ELIZA_DATA_DIR_GENERATED;
		delete process.env.ELIZA_DATA_DIR_UPLOADS_AGENTS;
		delete process.env.ELIZA_DATA_DIR_UPLOADS_CHANNELS;
	});

	afterEach(() => {
		resetPaths();
		process.env = { ...originalEnv };
	});

	it("resolves default directories relative to state dir and workspace", () => {
		const expectedDataDir = join(resolveStateDir(), "workspace");
		expect(getDataDir()).toBe(expectedDataDir);
		expect(getDatabaseDir()).toBe(join(expectedDataDir, ".elizadb"));
		expect(getCharactersDir()).toBe(
			join(expectedDataDir, "data", "characters"),
		);
		expect(getGeneratedDir()).toBe(join(expectedDataDir, "data", "generated"));
		expect(getUploadsAgentsDir()).toBe(
			join(expectedDataDir, "data", "uploads", "agents"),
		);
		expect(getUploadsChannelsDir()).toBe(
			join(expectedDataDir, "data", "uploads", "channels"),
		);
	});

	it("honors and trims ELIZA_DATA_DIR override", () => {
		process.env.ELIZA_DATA_DIR = "  /custom/workspace  ";
		expect(getDataDir()).toBe("/custom/workspace");
		expect(getCharactersDir()).toBe(
			join("/custom/workspace", "data", "characters"),
		);
	});

	it("honors ELIZA_DATABASE_DIR and fallback PGLITE_DATA_DIR", () => {
		process.env.PGLITE_DATA_DIR = "/pglite/db";
		expect(getDatabaseDir()).toBe("/pglite/db");

		resetPaths();
		process.env.ELIZA_DATABASE_DIR = "/eliza/db";
		expect(getDatabaseDir()).toBe("/eliza/db");
	});

	it("treats empty or whitespace-only env overrides as unset", () => {
		process.env.ELIZA_DATA_DIR = "   ";
		process.env.ELIZA_DATABASE_DIR = "";
		const expectedDataDir = join(resolveStateDir(), "workspace");
		expect(getDataDir()).toBe(expectedDataDir);
		expect(getDatabaseDir()).toBe(join(expectedDataDir, ".elizadb"));
	});

	it("returns all paths in getAllElizaPaths", () => {
		const all = getAllElizaPaths();
		expect(all).toHaveProperty("dataDir");
		expect(all).toHaveProperty("databaseDir");
		expect(all).toHaveProperty("charactersDir");
		expect(all).toHaveProperty("generatedDir");
		expect(all).toHaveProperty("uploadsAgentsDir");
		expect(all).toHaveProperty("uploadsChannelsDir");
	});
});
