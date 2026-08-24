/**
 * Unit tests for the personality capability's public barrel (`index.ts`):
 * imports everything through the same entry a consumer uses and exercises the
 * re-exported behavior end to end — reply-gate decisions, the bundled default
 * profiles registered into a real PersonalityStore over an in-memory memory
 * map, durable slot rehydration across a store restart, and the
 * `getPersonalityStore` runtime accessor. No live model, no database.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime, UUID } from "../../../../types/index.ts";
import { initStore, makeFakeRuntime } from "./__tests__/test-helpers.ts";
import {
	decideReplyGate,
	defaultProfiles,
	GLOBAL_PERSONALITY_SCOPE,
	getPersonalityStore,
	messageContainsLiftSignal,
	resolveEffectiveReplyGate,
} from "./index.ts";
import { PersonalityStore } from "./services/personality-store.ts";
import type { PersonalitySlot } from "./types.ts";

const AGENT_ID = "00000000-0000-4000-8000-00000000a001" as UUID;
const USER_ID = "00000000-0000-4000-8000-00000000u001" as UUID;

function slotWith(replyGate: PersonalitySlot["reply_gate"]): PersonalitySlot {
	return {
		userId: USER_ID,
		agentId: AGENT_ID,
		verbosity: null,
		tone: null,
		formality: null,
		reply_gate: replyGate,
		custom_directives: [],
		updated_at: "2026-01-01T00:00:00.000Z",
		source: "user",
		trait_sources: {},
	};
}

describe("personality capability barrel (index.ts)", () => {
	describe("re-exported reply-gate resolution", () => {
		it("gives the user slot precedence over the global slot", () => {
			expect(
				resolveEffectiveReplyGate(slotWith("on_mention"), slotWith("always")),
			).toEqual({ mode: "on_mention", scope: "user" });
			expect(
				resolveEffectiveReplyGate(null, slotWith("never_until_lift")),
			).toEqual({ mode: "never_until_lift", scope: "global" });
			expect(resolveEffectiveReplyGate(null, null)).toEqual({
				mode: null,
				scope: null,
			});
		});

		it("denies unaddressed turns when only the global slot gates on_mention", () => {
			const globalOnly = {
				userSlot: null,
				globalSlot: slotWith("on_mention"),
				messageText: "general chatter",
				explicitlyAddressesAgent: false,
			};
			expect(decideReplyGate(globalOnly)).toEqual({
				allow: false,
				reason: "on_mention_not_addressed",
				gateMode: "on_mention",
				scope: "global",
			});

			expect(
				decideReplyGate({ ...globalOnly, explicitlyAddressesAgent: true }),
			).toEqual({ allow: true, reason: "on_mention_satisfied" });
		});

		it("lifts never_until_lift only on anchored wake phrases or direct address", () => {
			expect(messageContainsLiftSignal("  PLEASE UNMUTE now", false)).toBe(
				true,
			);
			expect(messageContainsLiftSignal("he said wake up earlier", false)).toBe(
				false,
			);
			expect(messageContainsLiftSignal("still muted", true)).toBe(true);
		});
	});

	describe("bundled default profiles through a real store", () => {
		it("registers every default profile on store start", async () => {
			const fake = makeFakeRuntime();
			await initStore(fake);

			expect(fake.store.listProfiles().map((p) => p.name)).toEqual(
				defaultProfiles.map((p) => p.name),
			);
		});

		it("loads a profile into the global slot with admin provenance and audit", async () => {
			const fake = makeFakeRuntime();
			await initStore(fake);

			const before = fake.store.getSlot(GLOBAL_PERSONALITY_SCOPE);
			expect(before.reply_gate).toBeNull();
			expect(before.custom_directives).toEqual([]);

			const focused = defaultProfiles.find((p) => p.name === "focused");
			if (!focused) throw new Error("defaultProfiles must contain 'focused'");

			await fake.store.loadProfileIntoGlobal(focused);

			const after = fake.store.getSlot(GLOBAL_PERSONALITY_SCOPE);
			expect(after.verbosity).toBe("terse");
			expect(after.tone).toBe("direct");
			expect(after.formality).toBe("professional");
			expect(after.reply_gate).toBe("always");
			expect(after.source).toBe("admin");
			expect(after.custom_directives).toEqual(focused.custom_directives);
			expect(after.trait_sources).toEqual({
				verbosity: "admin",
				tone: "admin",
				formality: "admin",
				reply_gate: "admin",
			});
			expect(fake.store.getRecentAudit()[0]?.action).toBe(
				"load_profile:focused",
			);
		});

		it("restores the character.json baseline when the default profile loads", async () => {
			const fake = makeFakeRuntime();
			await initStore(fake);

			const focused = defaultProfiles.find((p) => p.name === "focused");
			const baseline = defaultProfiles.find((p) => p.name === "default");
			if (!focused || !baseline) {
				throw new Error("defaultProfiles must contain 'focused' and 'default'");
			}

			await fake.store.loadProfileIntoGlobal(focused);
			await fake.store.loadProfileIntoGlobal(baseline);

			const restored = fake.store.getSlot(GLOBAL_PERSONALITY_SCOPE);
			expect(restored.verbosity).toBeNull();
			expect(restored.tone).toBeNull();
			expect(restored.formality).toBeNull();
			expect(restored.reply_gate).toBeNull();
			expect(restored.custom_directives).toEqual([]);
			expect(restored.trait_sources).toEqual({});
		});

		it("rehydrates the persisted global slot after a store restart", async () => {
			const fake = makeFakeRuntime();
			await initStore(fake);

			const focused = defaultProfiles.find((p) => p.name === "focused");
			if (!focused) throw new Error("defaultProfiles must contain 'focused'");
			await fake.store.loadProfileIntoGlobal(focused);

			const revived = await PersonalityStore.start(fake.runtime);
			expect(revived.getSlot(GLOBAL_PERSONALITY_SCOPE).verbosity).toBe("terse");
			expect(revived.getSlot(GLOBAL_PERSONALITY_SCOPE).tone).toBe("direct");
			expect(
				revived.getSlot(GLOBAL_PERSONALITY_SCOPE).custom_directives,
			).toEqual(focused.custom_directives);
		});
	});

	describe("getPersonalityStore runtime accessor", () => {
		it("returns null when no personality store service is registered", () => {
			const bareRuntime = {
				agentId: AGENT_ID,
				getService: () => null,
			} as unknown as IAgentRuntime;

			expect(getPersonalityStore(bareRuntime)).toBeNull();
		});

		it("resolves the registered store instance by its canonical service type", async () => {
			const fake = makeFakeRuntime();
			await initStore(fake);

			expect(getPersonalityStore(fake.runtime)).toBe(fake.store);
		});
	});
});
