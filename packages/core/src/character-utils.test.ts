/**
 * Character secret/plugin helpers are documented as IMMUTABLE — every mutator
 * returns a NEW character and must not mutate the input (callers rely on this to
 * avoid leaking secrets across agent configs). mergeCharacterSecrets must keep
 * EXISTING values (never let an incoming map overwrite a configured secret), and
 * model-provider detection keys off the known provider→secret map.
 */
import { describe, expect, it } from "vitest";
import {
	addCharacterPlugin,
	deleteCharacterSecret,
	getCharacterSecret,
	getConfiguredModelProviders,
	getModelProvider,
	hasCharacterPlugin,
	hasCharacterSecret,
	listCharacterSecretKeys,
	MODEL_PROVIDER_SECRETS,
	mergeCharacterSecrets,
	removeCharacterPlugin,
	setCharacterSecret,
} from "./character-utils.ts";
import type { Character } from "./types";

const base = (): Character =>
	({
		name: "Tester",
		settings: { secrets: { A: "alpha" } },
		plugins: ["@x/one"],
	}) as Character;

describe("secret get/set/has/delete are immutable", () => {
	it("getCharacterSecret returns the value or null", () => {
		const c = base();
		expect(getCharacterSecret(c, "A")).toBe("alpha");
		expect(getCharacterSecret(c, "MISSING")).toBeNull();
		expect(hasCharacterSecret(c, "A")).toBe(true);
	});

	it("setCharacterSecret returns a new character, leaves the original untouched", () => {
		const c = base();
		const next = setCharacterSecret(c, "B", "bravo");
		expect(getCharacterSecret(next, "B")).toBe("bravo");
		expect(getCharacterSecret(c, "B")).toBeNull(); // original unchanged
		expect(next).not.toBe(c);
	});

	it("deleteCharacterSecret removes only the target key", () => {
		const c = base();
		const next = deleteCharacterSecret(c, "A");
		expect(hasCharacterSecret(next, "A")).toBe(false);
		expect(hasCharacterSecret(c, "A")).toBe(true);
		expect(listCharacterSecretKeys(base())).toEqual(["A"]);
	});

	it("listCharacterSecretKeys returns an empty list when secrets are absent", () => {
		expect(listCharacterSecretKeys({ name: "NoSecrets" } as Character)).toEqual(
			[],
		);
	});
});

describe("mergeCharacterSecrets", () => {
	it("keeps existing values; only fills in new keys", () => {
		const merged = mergeCharacterSecrets(base(), {
			A: "OVERWRITE",
			C: "charlie",
		});
		expect(getCharacterSecret(merged, "A")).toBe("alpha"); // existing wins
		expect(getCharacterSecret(merged, "C")).toBe("charlie"); // new key added
	});
});

describe("plugin management is immutable", () => {
	it("adds without duplicating and removes cleanly", () => {
		const c = base();
		expect(addCharacterPlugin(c, "@x/one")).toBe(c); // already present → same ref
		const added = addCharacterPlugin(c, "@x/two");
		expect(hasCharacterPlugin(added, "@x/two")).toBe(true);
		expect(hasCharacterPlugin(c, "@x/two")).toBe(false);
		const removed = removeCharacterPlugin(added, "@x/one");
		expect(hasCharacterPlugin(removed, "@x/one")).toBe(false);
	});
});

describe("model provider detection", () => {
	it("detects a provider from its known secret key", () => {
		const [provider, secretKey] = Object.entries(MODEL_PROVIDER_SECRETS)[0];
		const c = setCharacterSecret(
			{ name: "X", settings: { secrets: {} } } as Character,
			secretKey,
			"sk-test",
		);
		expect(getModelProvider(c)).toBe(provider);
		expect(getConfiguredModelProviders(c)).toContain(provider);
	});

	it("returns null when no provider key is set", () => {
		expect(
			getModelProvider({ name: "X", settings: { secrets: {} } } as Character),
		).toBeNull();
	});
});
