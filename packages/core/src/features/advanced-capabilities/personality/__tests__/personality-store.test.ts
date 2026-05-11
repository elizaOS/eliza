import { describe, expect, test } from "vitest";
import { defaultProfiles } from "../profiles/index.ts";
import { PersonalityStore } from "../services/personality-store.ts";
import {
	GLOBAL_PERSONALITY_SCOPE,
	MAX_CUSTOM_DIRECTIVES,
	type PersonalityProfile,
} from "../types.ts";
import { makeFakeRuntime } from "./test-helpers.ts";

const AGENT = "00000000-0000-4000-8000-000000000aaa" as const;
const USER_A = "00000000-0000-4000-8000-000000000aab" as const;
const USER_B = "00000000-0000-4000-8000-000000000aac" as const;

function bareStore() {
	const fake = makeFakeRuntime({ agentId: AGENT as unknown as typeof AGENT });
	// Seed default profiles
	for (const profile of defaultProfiles) {
		fake.store.saveProfile(profile);
	}
	return fake.store;
}

describe("PersonalityStore", () => {
	test("getSlot returns an empty slot when none persisted", () => {
		const store = bareStore();
		const slot = store.getSlot(USER_A as never, AGENT as never);
		expect(slot.verbosity).toBeNull();
		expect(slot.tone).toBeNull();
		expect(slot.formality).toBeNull();
		expect(slot.reply_gate).toBeNull();
		expect(slot.custom_directives).toEqual([]);
	});

	test("applyTrait writes user-scope slot and audit entry", () => {
		const store = bareStore();
		const { after } = store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "verbosity",
			value: "terse",
		});
		expect(after.verbosity).toBe("terse");
		const audit = store.getRecentAudit();
		expect(audit.length).toBeGreaterThan(0);
		expect(audit[0].action).toBe("set_trait:verbosity=terse");
		expect(audit[0].scope).toBe("user");
		expect(audit[0].targetId).toBe(USER_A);
	});

	test("user scope writes do not leak into global slot", () => {
		const store = bareStore();
		store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "tone",
			value: "warm",
		});
		const globalSlot = store.getSlot(GLOBAL_PERSONALITY_SCOPE, AGENT as never);
		expect(globalSlot.tone).toBeNull();
	});

	test("two users keep independent slots", () => {
		const store = bareStore();
		store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "verbosity",
			value: "terse",
		});
		store.applyTrait({
			scope: "user",
			userId: USER_B as never,
			agentId: AGENT as never,
			actorId: USER_B as never,
			trait: "verbosity",
			value: "verbose",
		});
		expect(
			store.getSlot(USER_A as never, AGENT as never).verbosity,
		).toBe("terse");
		expect(
			store.getSlot(USER_B as never, AGENT as never).verbosity,
		).toBe("verbose");
	});

	test("global scope write applies across users via getSlot('global')", () => {
		const store = bareStore();
		store.applyTrait({
			scope: "global",
			userId: USER_A as never, // ignored for global scope
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "tone",
			value: "direct",
		});
		expect(
			store.getSlot(GLOBAL_PERSONALITY_SCOPE, AGENT as never).tone,
		).toBe("direct");
	});

	test("addDirective evicts FIFO at the cap", () => {
		const store = bareStore();
		for (let i = 0; i < MAX_CUSTOM_DIRECTIVES + 3; i++) {
			store.addDirective({
				userId: USER_A as never,
				agentId: AGENT as never,
				actorId: USER_A as never,
				directive: `directive #${i}`,
			});
		}
		const slot = store.getSlot(USER_A as never, AGENT as never);
		expect(slot.custom_directives).toHaveLength(MAX_CUSTOM_DIRECTIVES);
		// Oldest evicted — index 0..2 gone, slot starts at 3.
		expect(slot.custom_directives[0]).toBe("directive #3");
		expect(slot.custom_directives[MAX_CUSTOM_DIRECTIVES - 1]).toBe(
			`directive #${MAX_CUSTOM_DIRECTIVES + 2}`,
		);
	});

	test("clearDirectives wipes the list", () => {
		const store = bareStore();
		store.addDirective({
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			directive: "one",
		});
		store.clearDirectives({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
		});
		expect(
			store.getSlot(USER_A as never, AGENT as never).custom_directives,
		).toEqual([]);
	});

	test("loadProfileIntoGlobal applies all trait fields atomically", () => {
		const store = bareStore();
		const profile: PersonalityProfile = {
			name: "test",
			description: "test profile",
			verbosity: "terse",
			tone: "direct",
			formality: "professional",
			reply_gate: "always",
			custom_directives: ["directive a"],
		};
		store.saveProfile(profile);
		store.loadProfileIntoGlobal(profile, AGENT as never, USER_A as never);
		const slot = store.getSlot(GLOBAL_PERSONALITY_SCOPE, AGENT as never);
		expect(slot.verbosity).toBe("terse");
		expect(slot.tone).toBe("direct");
		expect(slot.formality).toBe("professional");
		expect(slot.reply_gate).toBe("always");
		expect(slot.custom_directives).toEqual(["directive a"]);
	});

	test("listProfiles returns the seeded defaults", () => {
		const store = bareStore();
		const names = store.listProfiles().map((p) => p.name);
		expect(names).toContain("default");
		expect(names).toContain("focused");
		expect(names).toContain("aggressive");
		expect(names).toContain("gentle");
		expect(names).toContain("terse");
	});
});
