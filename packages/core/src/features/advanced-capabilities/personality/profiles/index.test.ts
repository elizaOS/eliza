/**
 * Unit-tests the bundled personality profile catalog (defaultProfiles) through
 * its real consumer: a PersonalityStore started via PersonalityStore.start(),
 * which dynamic-imports this module on initialize and registers each entry by
 * name. Covers registration-key uniqueness, name-keyed lookup with detached
 * copies, canonical trait-value membership, the all-null baseline-reset
 * semantic of `default`, and full-slot application of every non-default
 * profile. Deterministic — no live model and no database.
 */
import { describe, expect, test } from "vitest";
import { initStore, makeFakeRuntime } from "../__tests__/test-helpers.ts";
import {
	FORMALITY_VALUES,
	type PersonalityProfile,
	REPLY_GATE_VALUES,
	TONE_VALUES,
	VERBOSITY_VALUES,
} from "../types.ts";
import { defaultProfiles } from "./index.ts";

async function startedStore() {
	const fake = makeFakeRuntime();
	await initStore(fake);
	return { store: fake.store, agentId: fake.runtime.agentId };
}

function findProfile(name: string): PersonalityProfile {
	const profile = defaultProfiles.find((entry) => entry.name === name);
	if (!profile) {
		throw new Error(`expected a bundled profile named "${name}"`);
	}
	return profile;
}

describe("defaultProfiles", () => {
	test("registers every bundled profile under its own unique name", async () => {
		const names = defaultProfiles.map((profile) => profile.name);
		expect(new Set(names).size).toBe(names.length);

		const { store } = await startedStore();
		const registered = new Set(store.listProfiles().map((p) => p.name));
		for (const name of names) {
			expect(registered.has(name)).toBe(true);
		}
	});

	test("getProfile resolves each bundled name and returns a detached copy", async () => {
		const { store } = await startedStore();
		for (const profile of defaultProfiles) {
			expect(store.getProfile(profile.name)).toEqual(profile);
			const copy = store.getProfile(profile.name);
			if (!copy) throw new Error("unreachable");
			copy.custom_directives.push("mutation probe");
			expect(store.getProfile(profile.name)).toEqual(profile);
		}
	});

	test("getProfile returns null for an unknown name", async () => {
		const { store } = await startedStore();
		expect(store.getProfile("does-not-exist")).toBeNull();
	});

	test("trait values stay inside the canonical runtime value lists", () => {
		for (const profile of defaultProfiles) {
			if (profile.verbosity !== null) {
				expect(VERBOSITY_VALUES).toContain(profile.verbosity);
			}
			if (profile.tone !== null) {
				expect(TONE_VALUES).toContain(profile.tone);
			}
			if (profile.formality !== null) {
				expect(FORMALITY_VALUES).toContain(profile.formality);
			}
			if (profile.reply_gate !== null) {
				expect(REPLY_GATE_VALUES).toContain(profile.reply_gate);
			}
			expect(Array.isArray(profile.custom_directives)).toBe(true);
			for (const directive of profile.custom_directives) {
				expect(typeof directive).toBe("string");
				expect(directive.length).toBeGreaterThan(0);
			}
		}
	});

	test("default carries no overrides so loading it restores the baseline", () => {
		const fallback = findProfile("default");
		expect(fallback.verbosity).toBeNull();
		expect(fallback.tone).toBeNull();
		expect(fallback.formality).toBeNull();
		expect(fallback.reply_gate).toBeNull();
		expect(fallback.custom_directives).toEqual([]);
	});

	test("every non-default profile actually overrides something", () => {
		for (const profile of defaultProfiles) {
			if (profile.name === "default") continue;
			const overrides =
				profile.verbosity !== null ||
				profile.tone !== null ||
				profile.formality !== null ||
				profile.reply_gate !== null ||
				profile.custom_directives.length > 0;
			expect(overrides).toBe(true);
		}
	});

	test("loadProfileIntoGlobal applies every field, then default resets the slot", async () => {
		const { store, agentId } = await startedStore();

		await store.loadProfileIntoGlobal(findProfile("focused"));
		let slot = store.getSlot("global", agentId);
		expect(slot.verbosity).toBe("terse");
		expect(slot.tone).toBe("direct");
		expect(slot.formality).toBe("professional");
		expect(slot.reply_gate).toBe("always");
		expect(slot.custom_directives.length).toBeGreaterThan(0);
		expect(slot.trait_sources).toEqual({
			verbosity: "admin",
			tone: "admin",
			formality: "admin",
			reply_gate: "admin",
		});

		await store.loadProfileIntoGlobal(findProfile("default"));
		slot = store.getSlot("global", agentId);
		expect(slot.verbosity).toBeNull();
		expect(slot.tone).toBeNull();
		expect(slot.formality).toBeNull();
		expect(slot.reply_gate).toBeNull();
		expect(slot.custom_directives).toEqual([]);
		expect(slot.trait_sources).toEqual({});
	});

	test("each non-default profile fills the global slot with its own values", async () => {
		const { store, agentId } = await startedStore();
		for (const profile of defaultProfiles) {
			if (profile.name === "default") continue;
			const { after } = await store.loadProfileIntoGlobal(profile, agentId);
			expect(after.verbosity).toBe(profile.verbosity);
			expect(after.tone).toBe(profile.tone);
			expect(after.formality).toBe(profile.formality);
			expect(after.reply_gate).toBe(profile.reply_gate);
			expect(after.custom_directives).toEqual(profile.custom_directives);
		}
	});
});
