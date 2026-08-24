/**
 * Unit-tests the PersonalityStore service (built on the in-memory FakeRuntime):
 * per-user vs global slot isolation, trait writes and their audit entries,
 * lossless directive retention, profile load/save, and the seeded default
 * profiles. Deterministic — no live model.
 */
import { describe, expect, test } from "vitest";
import { defaultProfiles } from "../profiles/index.ts";
import {
	GLOBAL_PERSONALITY_SCOPE,
	PERSONALITY_SLOT_TABLE,
	type PersonalityProfile,
} from "../types.ts";
import { initStore, makeFakeRuntime } from "./test-helpers.ts";

const AGENT = "00000000-0000-4000-8000-000000000aaa" as const;
const USER_A = "00000000-0000-4000-8000-000000000aab" as const;
const USER_B = "00000000-0000-4000-8000-000000000aac" as const;
const AGENT_B = "00000000-0000-4000-8000-000000000bbb" as const;

function seedSlotMemory(args: {
	fake: ReturnType<typeof makeFakeRuntime>;
	id: string;
	slot: unknown;
}) {
	args.fake.memories.set(PERSONALITY_SLOT_TABLE, [
		{
			id: args.id as never,
			entityId: AGENT as never,
			roomId: AGENT as never,
			agentId: AGENT as never,
			content: {
				text: "personality_slot global",
				source: "personality_slot",
			},
			createdAt: 0,
			metadata: {
				type: "custom",
				source: "personality_slot",
				slot: args.slot,
			},
		},
	]);
}

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

	test("addDirective retains every directive", async () => {
		const store = bareStore();
		for (let i = 0; i < 8; i++) {
			await store.addDirective({
				userId: USER_A as never,
				agentId: AGENT as never,
				actorId: USER_A as never,
				directive: `directive #${i}`,
			});
		}
		const slot = store.getSlot(USER_A as never, AGENT as never);
		expect(slot.custom_directives).toEqual(
			Array.from({ length: 8 }, (_, index) => `directive #${index}`),
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

	test("applyReplyGate writes gate, provenance, and audit for a user slot", async () => {
		const store = bareStore();
		const { after } = await store.applyReplyGate({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			mode: "on_mention",
		});
		expect(after.reply_gate).toBe("on_mention");
		expect(after.trait_sources.reply_gate).toBe("user");
		expect(store.getSlot(USER_A as never, AGENT as never).reply_gate).toBe(
			"on_mention",
		);
		expect(store.getRecentAudit()[0]?.action).toBe("set_reply_gate:on_mention");
	});

	test("applyReplyGate global scope defaults provenance to admin", async () => {
		const store = bareStore();
		await store.applyReplyGate({
			scope: "global",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			mode: "never_until_lift",
		});
		const slot = store.getSlot(GLOBAL_PERSONALITY_SCOPE, AGENT as never);
		expect(slot.reply_gate).toBe("never_until_lift");
		expect(slot.trait_sources.reply_gate).toBe("admin");
	});

	test("null reply-gate mode clears the gate and drops its provenance", async () => {
		const store = bareStore();
		await store.applyReplyGate({
			scope: "global",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			mode: "always",
		});
		const { before, after } = await store.applyReplyGate({
			scope: "global",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			mode: null,
		});
		expect(before.reply_gate).toBe("always");
		expect(after.reply_gate).toBeNull();
		expect("reply_gate" in after.trait_sources).toBe(false);
		expect(store.getRecentAudit()[0]?.action).toBe("set_reply_gate:null");
	});

	test("setting a trait to null drops its provenance and audits the clear", async () => {
		const store = bareStore();
		await store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "verbosity",
			value: "terse",
		});
		const { before, after } = await store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "verbosity",
			value: null,
		});
		expect(before.verbosity).toBe("terse");
		expect(before.trait_sources.verbosity).toBe("user");
		expect(after.verbosity).toBeNull();
		expect("verbosity" in after.trait_sources).toBe(false);
		expect(store.getRecentAudit()[0]?.action).toBe("set_trait:verbosity=null");
	});

	test("explicit source override stamps slot and trait provenance", async () => {
		const store = bareStore();
		const { after } = await store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "tone",
			value: "warm",
			source: "agent_inferred",
		});
		expect(after.source).toBe("agent_inferred");
		expect(after.trait_sources.tone).toBe("agent_inferred");
	});

	test("returned slots are defensive copies, not live cache references", async () => {
		const store = bareStore();
		await store.addDirective({
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			directive: "do not mutate",
		});
		const slot = store.getSlot(USER_A as never, AGENT as never);
		slot.custom_directives.push("caller mutation");
		slot.trait_sources.verbosity = "admin";
		const fresh = store.getSlot(USER_A as never, AGENT as never);
		expect(fresh.custom_directives).toEqual(["do not mutate"]);
		expect(fresh.trait_sources).toEqual({});
	});

	test("getProfile returns a defensive copy; unknown names return null", () => {
		const store = bareStore();
		const profile = store.getProfile("default");
		expect(profile).not.toBeNull();
		if (profile) {
			profile.custom_directives.push("mutation probe");
		}
		expect(
			store.getProfile("default")?.custom_directives.includes("mutation probe"),
		).toBe(false);
		expect(store.getProfile("no-such-profile")).toBeNull();
	});

	test("saveProfile snapshots its input instead of aliasing it", () => {
		const store = bareStore();
		const profile: PersonalityProfile = {
			name: "probe",
			description: "probe profile",
			verbosity: null,
			tone: "neutral",
			formality: null,
			reply_gate: null,
			custom_directives: ["original"],
		};
		store.saveProfile(profile);
		profile.custom_directives.push("mutated after save");
		expect(store.getProfile("probe")?.custom_directives).toEqual(["original"]);
	});

	test("snapshotSlotAsProfile registers the live slot as a named profile", async () => {
		const store = bareStore();
		await store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "verbosity",
			value: "terse",
		});
		await store.addDirective({
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			directive: "stay terse",
		});
		const snapshot = store.snapshotSlotAsProfile(
			store.getSlot(USER_A as never, AGENT as never),
			"probed",
			"snapshot probe",
		);
		expect(snapshot.verbosity).toBe("terse");
		expect(snapshot.tone).toBeNull();
		expect(snapshot.custom_directives).toEqual(["stay terse"]);
		expect(store.getProfile("probed")).toEqual(snapshot);
		expect(store.listProfiles().some((p) => p.name === "probed")).toBe(true);
	});

	test("setSlot caches a full slot, mirrors one durable row, and skips audit", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT as never });
		await initStore(fake);
		await fake.store.setSlot({
			userId: USER_A as never,
			agentId: AGENT as never,
			verbosity: "verbose",
			tone: "cold",
			formality: "formal",
			reply_gate: "addressed_or_ambient",
			custom_directives: ["seeded"],
			updated_at: new Date(0).toISOString(),
			source: "admin",
			trait_sources: { tone: "admin" },
		});
		const slot = fake.store.getSlot(USER_A as never, AGENT as never);
		expect(slot.verbosity).toBe("verbose");
		expect(slot.tone).toBe("cold");
		expect(slot.trait_sources).toEqual({ tone: "admin" });
		expect(fake.store.getRecentAudit()).toHaveLength(0);
		const rows = fake.memories.get(PERSONALITY_SLOT_TABLE) ?? [];
		expect(rows).toHaveLength(1);
	});

	test("getRecentAudit is newest-first and honors the limit", async () => {
		const store = bareStore();
		await store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "tone",
			value: "warm",
		});
		await store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "formality",
			value: "casual",
		});
		await store.applyTrait({
			scope: "user",
			userId: USER_A as never,
			agentId: AGENT as never,
			actorId: USER_A as never,
			trait: "verbosity",
			value: "terse",
		});
		expect(store.getRecentAudit().map((entry) => entry.action)).toEqual([
			"set_trait:verbosity=terse",
			"set_trait:formality=casual",
			"set_trait:tone=warm",
		]);
		expect(store.getRecentAudit(2).map((entry) => entry.action)).toEqual([
			"set_trait:verbosity=terse",
			"set_trait:formality=casual",
		]);
	});

	test("in-memory audit log caps at 1000 entries, keeping the newest", () => {
		const store = bareStore();
		for (let i = 0; i < 1005; i++) {
			store.recordAudit({
				actorId: USER_A as never,
				scope: "user",
				targetId: USER_A as never,
				action: `probe:${i}`,
				before: null,
				after: null,
				timestamp: new Date(i).toISOString(),
			});
		}
		const audit = store.getRecentAudit(1000);
		expect(audit).toHaveLength(1000);
		expect(audit[0]?.action).toBe("probe:1004");
		expect(audit[audit.length - 1]?.action).toBe("probe:5");
	});

	test("hydration ignores persisted slots owned by another agent", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT as never });
		seedSlotMemory({
			fake,
			id: "00000000-0000-4000-8000-000000000ccc",
			slot: {
				userId: GLOBAL_PERSONALITY_SCOPE,
				agentId: AGENT_B,
				verbosity: "terse",
				tone: null,
				formality: null,
				reply_gate: null,
				custom_directives: [],
				updated_at: new Date(0).toISOString(),
				source: "admin",
				trait_sources: {},
			},
		});
		await initStore(fake);
		expect(
			fake.store.getSlot(GLOBAL_PERSONALITY_SCOPE, AGENT as never).verbosity,
		).toBeNull();
	});

	test("initialization rejects a corrupt persisted slot with a typed error", async () => {
		const fake = makeFakeRuntime({ agentId: AGENT as never });
		seedSlotMemory({
			fake,
			id: "00000000-0000-4000-8000-000000000cdd",
			slot: { verbosity: "not-a-real-value" },
		});
		await expect(initStore(fake)).rejects.toMatchObject({
			code: "PERSONALITY_SLOT_MEMORY_INVALID",
		});
	});
});
