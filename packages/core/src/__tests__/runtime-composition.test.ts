/**
 * Tests for runtime composition: getBasicCapabilitiesSettings, mergeSettingsInto,
 * loadCharacters (object source, JSON file path, empty), createRuntimes with adapter override.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import {
	type AgentRecordForMerge,
	createRuntimes,
	getBasicCapabilitiesSettings,
	loadCharacters,
	mergeSettingsInto,
} from "../runtime-composition";
import type { Character } from "../types";
import { stringToUuid } from "../utils";

const DEFAULT_TEST_CHARACTER: Character = {
	name: "TestAgent",
	bio: ["Test agent"],
	system: "You are a test agent.",
	templates: {},
	plugins: [],
	knowledge: [],
	secrets: {},
	settings: {},
	messageExamples: [],
	postExamples: [],
	topics: ["testing"],
	adjectives: ["helpful", "test"],
	style: { all: [], chat: [], post: [] } as Character["style"],
};

function createTestCharacter(overrides: Partial<Character> = {}): Character {
	const name = overrides.name ?? "TestAgent";
	return {
		...DEFAULT_TEST_CHARACTER,
		id: stringToUuid(name),
		...overrides,
	};
}

describe("runtime-composition", () => {
	describe("getBasicCapabilitiesSettings", () => {
		it("returns a Record with string values only", () => {
			const character = createTestCharacter({
				settings: { FOO: "bar", NUM: 42 as unknown as string },
				secrets: { SECRET_KEY: "x" },
			});
			const env: NodeJS.ProcessEnv = { ENV_VAR: "envVal" };
			const out = getBasicCapabilitiesSettings(character, env);
			expect(out.FOO).toBe("bar");
			expect(out.NUM).toBe("42");
			expect(out.SECRET_KEY).toBe("x");
			expect(out.ENV_VAR).toBe("envVal");
			for (const v of Object.values(out)) {
				expect(typeof v).toBe("string");
			}
		});

		it("character settings override env for same key", () => {
			const character = createTestCharacter({
				settings: { POSTGRES_URL: "from-character" },
			});
			const env: NodeJS.ProcessEnv = { POSTGRES_URL: "from-env" };
			const out = getBasicCapabilitiesSettings(character, env);
			expect(out.POSTGRES_URL).toBe("from-character");
		});

		it("character.settings.secrets and character.secrets are merged", () => {
			const character = createTestCharacter({
				settings: { secrets: { A: "from-settings-secrets" } },
				secrets: { B: "from-top-secrets" },
			});
			const out = getBasicCapabilitiesSettings(character, {});
			expect(out.A).toBe("from-settings-secrets");
			expect(out.B).toBe("from-top-secrets");
		});

		it("skips nested settings.secrets as object key (handled separately)", () => {
			const character = createTestCharacter({
				settings: {
					secrets: { K: "v" },
					OTHER: "ok",
				} as Character["settings"],
			});
			const out = getBasicCapabilitiesSettings(character, {});
			expect(out.OTHER).toBe("ok");
			expect(out.K).toBe("v");
		});
	});

	describe("mergeSettingsInto", () => {
		it("returns character unchanged when agentRecord is null", () => {
			const character = createTestCharacter({ settings: { X: "c" } });
			const result = mergeSettingsInto(character, null);
			expect(result).toEqual(character);
		});

		it("returns character unchanged when agentRecord has no settings", () => {
			const character = createTestCharacter({ settings: { X: "c" } });
			const result = mergeSettingsInto(character, {});
			expect(result).toEqual(character);
		});

		it("merges DB base then character overrides (character wins)", () => {
			const character = createTestCharacter({
				settings: { KEY: "from-char", CHAR_ONLY: "char" },
			});
			const agentRecord: AgentRecordForMerge = {
				settings: { KEY: "from-db", DB_ONLY: "db" },
			};
			const result = mergeSettingsInto(character, agentRecord);
			expect(result.settings?.KEY).toBe("from-char");
			expect(result.settings?.DB_ONLY).toBe("db");
			expect(result.settings?.CHAR_ONLY).toBe("char");
		});

		it("merges secrets: db base, character overrides", () => {
			const character = createTestCharacter({
				secrets: { API_KEY: "char-secret" },
			});
			const agentRecord: AgentRecordForMerge = {
				settings: {},
				secrets: { API_KEY: "db-secret", DB_SECRET: "only-in-db" },
			};
			const result = mergeSettingsInto(character, agentRecord);
			expect(
				(result.settings?.secrets as Record<string, string>)?.API_KEY,
			).toBe("char-secret");
			expect(
				(result.settings?.secrets as Record<string, string>)?.DB_SECRET,
			).toBe("only-in-db");
		});
	});

	describe("loadCharacters", () => {
		let originalEnv: NodeJS.ProcessEnv;

		beforeEach(() => {
			originalEnv = { ...process.env };
		});

		afterEach(() => {
			process.env = originalEnv;
		});

		it("returns empty array when sources is empty", async () => {
			const result = await loadCharacters([]);
			expect(result).toEqual([]);
		});

		it("loads one character from inline object and sets id", async () => {
			const input = {
				name: "TestBot",
				bio: ["A test bot"],
				plugins: [],
				settings: {},
				secrets: {},
			};
			const result = await loadCharacters([input]);
			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe("TestBot");
			expect(result[0]?.id).toBeDefined();
			expect(typeof result[0]?.id).toBe("string");
		});

		it("preserves secrets on character (no sync to process.env)", async () => {
			const input = {
				name: "SecretBot",
				bio: ["Bot"],
				plugins: [],
				secrets: { MY_SECRET: "secret-value" },
			};
			const result = await loadCharacters([input]);
			expect(result[0]?.secrets?.MY_SECRET).toBe("secret-value");
		});

		it("throws on invalid character object (validation failure)", async () => {
			const invalidInput = { name: 123, bio: "not-an-array" } as unknown as {
				name: string;
				bio: string;
			};
			await expect(loadCharacters([invalidInput])).rejects.toThrow();
		});

		it("loads character from a JSON file path", async () => {
			const dir = mkdtempSync(join(tmpdir(), "eliza-load-chars-"));
			const file = join(dir, "character.json");
			writeFileSync(
				file,
				JSON.stringify({
					name: "FileBot",
					bio: ["from file"],
					plugins: [],
					settings: {},
					secrets: {},
				}),
				"utf8",
			);
			const result = await loadCharacters([file]);
			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe("FileBot");
		});

		it("throws when character file path does not exist", async () => {
			await expect(
				loadCharacters(["/nonexistent/eliza-character-xyz.json"]),
			).rejects.toThrow(/not found/);
		});

		it("resolves relative paths against options.cwd", async () => {
			const root = mkdtempSync(join(tmpdir(), "eliza-load-chars-cwd-"));
			const sub = join(root, "characters");
			mkdirSync(sub, { recursive: true });
			const file = join(sub, "bot.json");
			writeFileSync(
				file,
				JSON.stringify({
					name: "CwdBot",
					bio: ["from cwd option"],
					plugins: [],
					settings: {},
					secrets: {},
				}),
				"utf8",
			);
			const result = await loadCharacters(["bot.json"], { cwd: sub });
			expect(result).toHaveLength(1);
			expect(result[0]?.name).toBe("CwdBot");
		});
	});

	describe("createRuntimes", () => {
		it("returns empty array when characters is empty", async () => {
			const result = await createRuntimes([]);
			expect(result).toEqual([]);
		});

		it("returns one initialized runtime when given one character and adapter override", async () => {
			const character = createTestCharacter({
				name: "CompTest",
			});
			const adapter = new InMemoryDatabaseAdapter();

			const runtimes = await createRuntimes([character], {
				adapter,
				provision: false,
			});

			expect(runtimes).toHaveLength(1);
			const runtime = runtimes[0];
			expect(runtime).toBeDefined();
			expect(runtime?.character.name).toBe("CompTest");
			expect(runtime?.adapter).toBe(adapter);
			await runtime?.stop();
		}, 30_000);

		it("uses merged character (from mergeSettingsInto) when adapter returns agent", async () => {
			const character = createTestCharacter({
				name: "MergeTest",
				settings: { FROM_CHAR: "char-val" },
			});
			const agentId =
				character.id ?? stringToUuid(character.name ?? "MergeTest");
			const adapter = new InMemoryDatabaseAdapter();
			await adapter.createAgents([
				{
					id: agentId,
					name: "FromDB",
					settings: { FROM_DB: "db-val" },
					createdAt: Date.now(),
					updatedAt: Date.now(),
				},
			]);

			const runtimes = await createRuntimes([character], {
				adapter,
				provision: false,
			});

			const runtime = runtimes[0];
			expect(runtime?.character.settings?.FROM_DB).toBe("db-val");
			expect(runtime?.character.settings?.FROM_CHAR).toBe("char-val");
			await runtime?.stop();
		});
	});
});
