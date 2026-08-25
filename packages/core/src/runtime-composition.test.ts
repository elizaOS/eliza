/**
 * Unit tests for the pure runtime-composition helpers: settings flattening
 * (getBasicCapabilitiesSettings), the DB→character settings merge
 * (mergeSettingsInto), and character source loading (loadCharacters). These
 * functions are the shared boot building blocks for every host (daemon, cloud,
 * CLI), so their merge-order, null-filtering, and error semantics are
 * load-bearing contracts. Harness is deterministic: inline characters, temp
 * files, and explicit env records — no live model, DB, or network.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import type { CharacterInput } from "./character";
import { ElizaError } from "./errors";
import {
	getBasicCapabilitiesSettings,
	loadCharacters,
	mergeSettingsInto,
} from "./runtime-composition";
import type { Character } from "./types";

/** Loose settings/secrets records that intentionally carry null/undefined values. */
type LooseSettings = Record<string, unknown>;

function asSettings(value: LooseSettings): Character["settings"] {
	return value as unknown as Character["settings"];
}

/** Minimal valid character — parseCharacter only requires a non-empty name. */
function makeCharacter(overrides: Partial<Character> = {}): Character {
	return {
		name: "Test Character",
		...overrides,
	} as Character;
}

const FIXTURE_DIRS: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "runtime-composition-"));
	FIXTURE_DIRS.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(
		FIXTURE_DIRS.splice(0).map((d) => rm(d, { recursive: true, force: true })),
	);
});

describe("getBasicCapabilitiesSettings", () => {
	it("returns an empty record when env and character carry no settings", () => {
		expect(getBasicCapabilitiesSettings(makeCharacter(), {})).toEqual({});
	});

	it("flattens env entries to strings", () => {
		const env = {
			POSTGRES_URL: "postgres://localhost/eliza",
			WORKERS: 4,
			EMPTY: "",
		} as unknown as NodeJS.ProcessEnv;
		expect(getBasicCapabilitiesSettings(makeCharacter(), env)).toEqual({
			POSTGRES_URL: "postgres://localhost/eliza",
			WORKERS: "4",
			EMPTY: "",
		});
	});

	it("skips null/undefined env values", () => {
		const env = {
			KEEP: "keep",
			DROP_NULL: null,
			DROP_UNDEFINED: undefined,
		} as unknown as NodeJS.ProcessEnv;
		expect(getBasicCapabilitiesSettings(makeCharacter(), env)).toEqual({
			KEEP: "keep",
		});
	});

	it("lets character.settings override env keys", () => {
		const env = {
			POSTGRES_URL: "postgres://from-env",
		} as unknown as NodeJS.ProcessEnv;
		const character = makeCharacter({
			settings: asSettings({ POSTGRES_URL: "postgres://from-character" }),
		});
		expect(getBasicCapabilitiesSettings(character, env).POSTGRES_URL).toBe(
			"postgres://from-character",
		);
	});

	it("stringifies non-string setting values", () => {
		const character = makeCharacter({
			settings: asSettings({ VOICE: true, MAX_TOKENS: 8192, RATIO: 0.25 }),
		});
		expect(getBasicCapabilitiesSettings(character, {})).toEqual({
			VOICE: "true",
			MAX_TOKENS: "8192",
			RATIO: "0.25",
		});
	});

	it("skips null/undefined setting values entirely", () => {
		const character = makeCharacter({
			settings: asSettings({
				PRESENT: "yes",
				ABSENT: null,
				MISSING: undefined,
			}),
		});
		expect(getBasicCapabilitiesSettings(character, {})).toEqual({
			PRESENT: "yes",
		});
	});

	it("defers the nested settings.secrets object to the secrets pass, where character.secrets overrides it", () => {
		const character = makeCharacter({
			settings: asSettings({
				secrets: { SHARED: "from-settings-secrets", ONLY_SETTINGS: "s" },
			}),
			secrets: { SHARED: "from-top-secrets", ONLY_TOP: "t" },
		});
		const result = getBasicCapabilitiesSettings(character, {});
		// Documented merge order: env, settings (sans nested secrets), settings.secrets,
		// then character.secrets — later sources override earlier, so top-level wins.
		expect(result).toEqual({
			SHARED: "from-top-secrets",
			ONLY_SETTINGS: "s",
			ONLY_TOP: "t",
		});
	});

	it("flattens both secrets sources into the same record as plain settings", () => {
		const character = makeCharacter({
			settings: asSettings({
				PLAIN: "plain",
				secrets: { EMBEDDED: "embedded" },
			}),
			secrets: { TOP: "top" },
		});
		expect(getBasicCapabilitiesSettings(character, {})).toEqual({
			PLAIN: "plain",
			EMBEDDED: "embedded",
			TOP: "top",
		});
	});

	it("drops null/undefined secrets values during flattening", () => {
		const character = makeCharacter({
			settings: asSettings({ secrets: { NULLED: null, KEPT: "kept" } }),
			secrets: { UNDEFINED: undefined } as unknown as Record<string, string>,
		});
		expect(getBasicCapabilitiesSettings(character, {})).toEqual({
			KEPT: "kept",
		});
	});

	it("defaults to process.env when the env argument is omitted", () => {
		const prev = process.env.RC_TEST_FALLBACK;
		process.env.RC_TEST_FALLBACK = "from-process-env";
		try {
			expect(
				getBasicCapabilitiesSettings(makeCharacter()).RC_TEST_FALLBACK,
			).toBe("from-process-env");
		} finally {
			if (prev === undefined) {
				process.env.RC_TEST_FALLBACK = undefined;
				delete process.env.RC_TEST_FALLBACK;
			} else {
				process.env.RC_TEST_FALLBACK = prev;
			}
		}
	});
});

describe("mergeSettingsInto", () => {
	it("returns the character unchanged when agentRecord is null", () => {
		const character = makeCharacter();
		expect(mergeSettingsInto(character, null)).toBe(character);
	});

	it("returns the character unchanged when the record has no settings", () => {
		const character = makeCharacter();
		expect(mergeSettingsInto(character, { secrets: { S: "s" } })).toBe(
			character,
		);
	});

	it("keeps the character's own settings when the DB record omits that key", () => {
		const character = makeCharacter({
			settings: asSettings({ defaultTemperature: 0.7 }),
		});
		const merged = mergeSettingsInto(character, { settings: {} });
		expect(merged.settings).toEqual({ defaultTemperature: 0.7 });
	});

	it("character settings override DB base settings; DB-only keys are added", () => {
		const character = makeCharacter({
			settings: asSettings({ defaultTemperature: 0.9, defaultMaxTokens: 4096 }),
		});
		const merged = mergeSettingsInto(character, {
			settings: { defaultTemperature: 0.1, providersTotalTimeoutMs: 5000 },
		});
		expect(merged.settings).toEqual({
			defaultTemperature: 0.9,
			defaultMaxTokens: 4096,
			providersTotalTimeoutMs: 5000,
		});
	});

	it("merges secrets across all four sources with character settings.secrets winning", () => {
		const character = makeCharacter({
			settings: asSettings({
				secrets: { SHARED: "character-settings", C_SETTINGS: "cs" },
			}),
			secrets: { SHARED: "character-top", C_TOP: "ct" },
		});
		const merged = mergeSettingsInto(character, {
			settings: { secrets: { SHARED: "db-settings", DB_SETTINGS: "ds" } },
			secrets: { SHARED: "db-top", DB_TOP: "dt" },
		});
		// Spread order: db secrets < db settings.secrets < character secrets < character settings.secrets.
		expect(merged.settings?.secrets).toEqual({
			SHARED: "character-settings",
			C_SETTINGS: "cs",
			C_TOP: "ct",
			DB_SETTINGS: "ds",
			DB_TOP: "dt",
		});
		// character.secrets becomes the merged (filtered) secrets object.
		expect(merged.secrets).toBe(merged.settings?.secrets);
	});

	it("drops null/undefined values from merged secrets", () => {
		const character = makeCharacter({ secrets: { KEEP: "keep" } });
		const merged = mergeSettingsInto(character, {
			settings: { secrets: { DROP: null, DB_ONLY_NULL: null } },
		});
		expect(merged.settings?.secrets).toEqual({ KEEP: "keep" });
		expect(merged.secrets).toEqual({ KEEP: "keep" });
	});

	it("stringifies non-string secret values", () => {
		const merged = mergeSettingsInto(makeCharacter(), {
			settings: { secrets: { PORTION: 0.5, FLAG: true } },
		});
		expect(merged.settings?.secrets).toEqual({ PORTION: "0.5", FLAG: "true" });
	});

	it("re-materializes character.secrets into the merged secrets record (stringified)", () => {
		const character = makeCharacter({
			settings: asSettings({ defaultTemperature: 0.5 }),
			secrets: { API_KEY: "keep-me" },
		});
		const merged = mergeSettingsInto(character, {
			settings: { defaultMaxTokens: 1024 },
		});
		// Even with no DB secrets, character.secrets participate in the merge and the
		// result exposes them as a new filtered object shared by both surfaces.
		expect(merged.secrets).not.toBe(character.secrets);
		expect(merged.secrets).toEqual({ API_KEY: "keep-me" });
		expect(merged.settings?.secrets).toBe(merged.secrets);
	});

	it("filters null DB secrets while keeping the character's surviving entries", () => {
		const character = makeCharacter({ secrets: { KEEP: "me" } });
		const merged = mergeSettingsInto(character, {
			settings: { secrets: { DROP: null } },
		});
		expect(merged.secrets).toEqual({ KEEP: "me" });
		expect(merged.settings?.secrets).toEqual({ KEEP: "me" });
	});

	it("does not mutate the input character", () => {
		const character = makeCharacter({
			settings: asSettings({ defaultTemperature: 0.5 }),
			secrets: { MINE: "mine" },
		});
		const snapshot = JSON.stringify(character);
		mergeSettingsInto(character, {
			settings: { defaultMaxTokens: 2048, secrets: { THEIRS: "theirs" } },
			secrets: { THEIRS: "theirs" },
		});
		expect(JSON.stringify(character)).toBe(snapshot);
	});
});

describe("loadCharacters", () => {
	it("returns [] for empty sources", async () => {
		expect(await loadCharacters([])).toEqual([]);
	});

	it("loads an inline character object without touching the filesystem", async () => {
		const [character] = await loadCharacters([{ name: "Inline Only" }]);
		expect(character.name).toBe("Inline Only");
	});

	it("derives a deterministic id from the name when the character has none", async () => {
		const [a] = await loadCharacters([{ name: "Derive Me" }]);
		const [b] = await loadCharacters([{ name: "Derive Me" }]);
		expect(a.id).toBeTruthy();
		expect(a.id).toBe(b.id);
	});

	it("resolves relative file paths against options.cwd", async () => {
		const dir = await tempDir();
		await writeFile(
			path.join(dir, "character.json"),
			JSON.stringify({ name: "From File" }),
			"utf8",
		);
		const [character] = await loadCharacters(["character.json"], { cwd: dir });
		expect(character.name).toBe("From File");
	});

	it("loads a mix of file paths and inline objects in order", async () => {
		const dir = await tempDir();
		await writeFile(
			path.join(dir, "a.json"),
			JSON.stringify({ name: "A" }),
			"utf8",
		);
		await writeFile(
			path.join(dir, "b.json"),
			JSON.stringify({ name: "B" }),
			"utf8",
		);
		const characters = await loadCharacters(
			["a.json", { name: "Inline" }, "b.json"],
			{
				cwd: dir,
			},
		);
		expect(characters.map((c) => c.name)).toEqual(["A", "Inline", "B"]);
	});

	it("throws for a missing file with the resolved path in the message", async () => {
		const dir = await tempDir();
		await expect(loadCharacters(["nope.json"], { cwd: dir })).rejects.toThrow(
			/character file not found: .*nope\.json/,
		);
	});

	it("wraps invalid JSON in ElizaError with code CHARACTER_SOURCE_LOAD_FAILED and the resolved source", async () => {
		const dir = await tempDir();
		const file = path.join(dir, "broken.json");
		await writeFile(file, "{ not json", "utf8");
		const error: ElizaError = await loadCharacters(["broken.json"], {
			cwd: dir,
		}).catch((e) => e);
		expect(error).toBeInstanceOf(ElizaError);
		expect(error.code).toBe("CHARACTER_SOURCE_LOAD_FAILED");
		expect(error.context?.source).toBe(file);
	});

	it("wraps schema-invalid file characters in ElizaError with the same code", async () => {
		const dir = await tempDir();
		await writeFile(
			path.join(dir, "invalid.json"),
			JSON.stringify({ nope: 1 }),
			"utf8",
		);
		const error: ElizaError = await loadCharacters(["invalid.json"], {
			cwd: dir,
		}).catch((e) => e);
		expect(error).toBeInstanceOf(ElizaError);
		expect(error.code).toBe("CHARACTER_SOURCE_LOAD_FAILED");
	});

	it("throws a validation error for an inline object that fails validation", async () => {
		const invalid = { nope: true } as unknown as CharacterInput;
		await expect(loadCharacters([invalid])).rejects.toThrow(
			/validation failed/i,
		);
	});
});
