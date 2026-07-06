/**
 * Unit-tests the PersonalityStore service (built on the in-memory FakeRuntime):
 * per-user vs global slot isolation, trait writes and their audit entries, FIFO
 * directive eviction at the cap, profile load/save, and the seeded default
 * profiles. Deterministic — no live model.
 */
import { describe, expect, test } from "vitest";
import { defaultProfiles } from "../profiles/index.ts";
import {
	GLOBAL_PERSONALITY_SCOPE,
	MAX_CUSTOM_DIRECTIVES,
	PERSONALITY_SLOT_TABLE,
	type PersonalityProfile,
} from "../types.ts";
import { initStore, makeFakeRuntime } from "./test-helpers.ts";

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

	test("applyTrait writes user-scope slot and audit entry", async () => {
		const store = bareStore();
		const { after } = await store.applyTrait({
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

	test("user scope writes do not leak into global slot", async () => {
		const store = bareStore();
		await store.applyTrait({
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

	test("two users keep independent slots", async () => {
		const store = bareStore();
		await store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "verbosity",
			value: "terse",
		});
		await store.applyTrait({
			scope: "user",
			userId: USER_B as never,
			agentId: AGENT as never,
			actorId: USER_B as never,
			trait: "verbosity",
			value: "verbose",
		});
		expect(store.getSlot(USER_A as never, AGENT as never).verbosity).toBe(
			"terse",
		);
		expect(store.getSlot(USER_B as never, AGENT as never).verbosity).toBe(
			"verbose",
		);
	});

	test("global scope write applies across users via getSlot('global')", async () => {
		const store = bareStore();
		await store.applyTrait({
			scope: "global",
			userId: USER_A as never, // ignored for global scope
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "tone",
			value: "direct",
		});
		expect(store.getSlot(GLOBAL_PERSONALITY_SCOPE, AGENT as never).tone).toBe(
			"direct",
		);
	});

	test("addDirective evicts FIFO at the cap", async () => {
		const store = bareStore();
		for (let i = 0; i < MAX_CUSTOM_DIRECTIVES + 3; i++) {
			await store.addDirective({
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

	test("clearDirectives wipes the list", async () => {
		const store = bareStore();
		await store.addDirective({
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			directive: "one",
		});
		await store.clearDirectives({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
		});
		expect(
			store.getSlot(USER_A as never, AGENT as never).custom_directives,
		).toEqual([]);
	});

	test("loadProfileIntoGlobal applies all trait fields atomically", async () => {
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
		await store.loadProfileIntoGlobal(profile, AGENT as never, USER_A as never);
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

	test("hydrates persisted user and global slots into a fresh store", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT as never });
		await initStore(fake);
		await fake.store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "verbosity",
			value: "terse",
		});
		await fake.store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "formality",
			value: "casual",
		});
		await fake.store.applyTrait({
			scope: "global",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "tone",
			value: "direct",
		});

		expect(fake.memories.get(PERSONALITY_SLOT_TABLE)).toHaveLength(2);

		const reloaded = makeFakeRuntime({ agentId: AGENT as never });
		reloaded.memories.set(
			PERSONALITY_SLOT_TABLE,
			fake.memories.get(PERSONALITY_SLOT_TABLE) ?? [],
		);
		await initStore(reloaded);

		expect(
			reloaded.store.getSlot(USER_A as never, AGENT as never).verbosity,
		).toBe("terse");
		expect(
			reloaded.store.getSlot(USER_A as never, AGENT as never).formality,
		).toBe("casual");
		expect(
			reloaded.store.getSlot(GLOBAL_PERSONALITY_SCOPE, AGENT as never).tone,
		).toBe("direct");
	});

	test("concurrent same-slot mutations serialize — no lost update across the persist await", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT as never });
		await initStore(fake);
		// Slow the durable upsert down so unserialized read-modify-write
		// mutations WOULD interleave (both read the empty slot, last write
		// wins) — the per-slot chain must prevent exactly that.
		const runtimeWithUpsert = fake.runtime as unknown as {
			upsertMemory(memory: unknown, table: string): Promise<void>;
		};
		const originalUpsert = runtimeWithUpsert.upsertMemory.bind(fake.runtime);
		runtimeWithUpsert.upsertMemory = async (memory, table) => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			await originalUpsert(memory, table);
		};

		await Promise.all([
			fake.store.applyTrait({
				scope: "user",
				userId: USER_A as never,
				agentId: AGENT as never,
				actorId: USER_A as never,
				trait: "verbosity",
				value: "terse",
			}),
			fake.store.addDirective({
				userId: USER_A as never,
				agentId: AGENT as never,
				actorId: USER_A as never,
				directive: "no emojis",
			}),
		]);

		const slot = fake.store.getSlot(USER_A as never, AGENT as never);
		expect(slot.verbosity).toBe("terse");
		expect(slot.custom_directives).toEqual(["no emojis"]);
		// The durable mirror must carry both changes too, in one row.
		const rows = fake.memories.get(PERSONALITY_SLOT_TABLE) ?? [];
		expect(rows).toHaveLength(1);
		const persisted = (
			rows[0].metadata as { slot?: Record<string, unknown> } | undefined
		)?.slot;
		expect(persisted?.verbosity).toBe("terse");
		expect(persisted?.custom_directives).toEqual(["no emojis"]);
	});

	test("clear removes mirrored slot memories", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT as never });
		await initStore(fake);
		await fake.store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "verbosity",
			value: "terse",
		});
		expect(fake.memories.get(PERSONALITY_SLOT_TABLE)).toHaveLength(1);

		await fake.store.clear();

		expect(
			fake.store.getSlot(USER_A as never, AGENT as never).verbosity,
		).toBeNull();
		expect(fake.memories.get(PERSONALITY_SLOT_TABLE)).toEqual([]);
	});
});
