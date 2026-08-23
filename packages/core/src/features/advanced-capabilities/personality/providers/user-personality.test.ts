/**
 * Exercises the user personality provider with the real in-memory personality
 * store, covering prompt precedence, provenance rendering, legacy compatibility,
 * absent services, and the provider's failure boundary. No live model is used.
 */
import { describe, expect, test } from "vitest";
import type { State, UUID } from "../../../../types/index.ts";
import {
	initStore,
	makeFakeRuntime,
	makeMessage,
} from "../__tests__/test-helpers.ts";
import type { PersonalitySlot } from "../types.ts";
import { USER_PREFS_TABLE } from "../types.ts";
import { userPersonalityProvider } from "./user-personality.ts";

const emptyState: State = { values: {}, data: {}, text: "" };
const userId = "00000000-0000-4000-8000-000000000101" as UUID;

function slot(
	agentId: UUID,
	overrides: Partial<PersonalitySlot>,
): PersonalitySlot {
	return {
		userId,
		agentId,
		verbosity: null,
		tone: null,
		formality: null,
		reply_gate: null,
		custom_directives: [],
		updated_at: new Date(0).toISOString(),
		source: "user",
		trait_sources: {},
		...overrides,
	};
}

function messageFor(agentId: UUID) {
	return makeMessage({ entityId: userId, agentId, text: "hello" });
}

describe("userPersonalityProvider", () => {
	test("declares its dynamic turn-scoped provider contract", () => {
		expect(userPersonalityProvider).toMatchObject({
			name: "userPersonalityPreferences",
			dynamic: true,
			contexts: ["general", "agent_internal"],
			contextGate: { anyOf: ["general", "agent_internal"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "USER" },
		});
	});

	test("renders global settings before more specific user settings", async () => {
		const fake = makeFakeRuntime();
		await initStore(fake);
		await fake.store.setSlot(
			slot(fake.runtime.agentId, {
				userId: "global",
				verbosity: "verbose",
				tone: "warm",
				formality: "formal",
				reply_gate: "on_mention",
				custom_directives: ["Use examples", "Explain acronyms"],
				source: "admin",
			}),
		);
		await fake.store.setSlot(
			slot(fake.runtime.agentId, {
				verbosity: "terse",
				tone: "direct",
				formality: "casual",
				reply_gate: "always",
				custom_directives: ["No emojis"],
			}),
		);

		const result = await userPersonalityProvider.get(
			fake.runtime,
			messageFor(fake.runtime.agentId),
			emptyState,
		);

		expect(result).toEqual({
			text: [
				"[GLOBAL PERSONALITY]",
				"- verbosity: verbose",
				"- tone: warm",
				"- formality: formal",
				"- reply_gate: on_mention",
				"- custom directives:",
				"  1. Use examples",
				"  2. Explain acronyms",
				"[/GLOBAL PERSONALITY]",
				"",
				"[PERSONALITY for THIS user]",
				"- verbosity: terse",
				"- tone: direct",
				"- formality: casual",
				"- custom directives:",
				"  1. No emojis",
				"[/PERSONALITY for THIS user]",
			].join("\n"),
			values: { hasUserPreferences: true, userPreferenceCount: 0 },
			data: { userId },
		});
	});

	test("names traits whose values were inferred", async () => {
		const fake = makeFakeRuntime();
		await initStore(fake);
		await fake.store.setSlot(
			slot(fake.runtime.agentId, {
				verbosity: "terse",
				tone: "neutral",
				source: "user",
				trait_sources: {
					verbosity: "agent_inferred",
					tone: "user",
				},
			}),
		);

		const result = await userPersonalityProvider.get(
			fake.runtime,
			messageFor(fake.runtime.agentId),
			emptyState,
		);

		expect(result.text).toContain(
			"- provenance: verbosity inferred from conversation, not explicitly set; offer to adjust if the user objects",
		);
	});

	test("uses a blanket provenance note for inferred directives", async () => {
		const fake = makeFakeRuntime();
		await initStore(fake);
		await fake.store.setSlot(
			slot(fake.runtime.agentId, {
				custom_directives: ["Prefer short paragraphs"],
				source: "agent_inferred",
			}),
		);

		const result = await userPersonalityProvider.get(
			fake.runtime,
			messageFor(fake.runtime.agentId),
			emptyState,
		);

		expect(result.text).toContain(
			"- provenance: some of these inferred from conversation, not explicitly set; offer to adjust if the user objects",
		);
	});

	test("renders valid legacy preferences without a personality service", async () => {
		const fake = makeFakeRuntime();
		(fake.runtime as unknown as { getService: () => null }).getService = () =>
			null;
		await fake.runtime.createMemory(
			{
				entityId: userId,
				roomId: fake.runtime.agentId,
				content: { text: "Respond in Spanish" },
			} as never,
			USER_PREFS_TABLE,
		);
		await fake.runtime.createMemory(
			{
				entityId: userId,
				roomId: fake.runtime.agentId,
				content: { text: "" },
			} as never,
			USER_PREFS_TABLE,
		);
		await fake.runtime.createMemory(
			{
				entityId: userId,
				roomId: fake.runtime.agentId,
				content: { text: "Avoid jargon" },
			} as never,
			USER_PREFS_TABLE,
		);

		const result = await userPersonalityProvider.get(
			fake.runtime,
			messageFor(fake.runtime.agentId),
			emptyState,
		);

		expect(result).toEqual({
			text: [
				"[USER INTERACTION PREFERENCES]",
				"The following preferences apply ONLY when responding to THIS specific user:",
				"1. Respond in Spanish",
				"2. Avoid jargon",
				"[/USER INTERACTION PREFERENCES]",
			].join("\n"),
			values: { hasUserPreferences: true, userPreferenceCount: 2 },
			data: { userId },
		});
	});

	test("reports a legacy lookup failure while preserving structured context", async () => {
		const fake = makeFakeRuntime();
		await initStore(fake);
		await fake.store.setSlot(slot(fake.runtime.agentId, { tone: "warm" }));
		const failure = new Error("legacy store unavailable");
		const reports: unknown[][] = [];
		(
			fake.runtime as unknown as {
				getMemories: () => Promise<never>;
				reportError: (...args: unknown[]) => void;
			}
		).getMemories = async () => {
			throw failure;
		};
		(
			fake.runtime as unknown as {
				reportError: (...args: unknown[]) => void;
			}
		).reportError = (...args) => reports.push(args);

		const result = await userPersonalityProvider.get(
			fake.runtime,
			messageFor(fake.runtime.agentId),
			emptyState,
		);

		expect(result.text).toContain("- tone: warm");
		expect(result.values).toEqual({
			hasUserPreferences: true,
			userPreferenceCount: 0,
		});
		expect(reports).toEqual([
			[
				"UserPersonalityProvider.legacyPreferences",
				failure,
				{ entityId: userId },
			],
		]);
	});

	test("returns the canonical empty result when no context exists", async () => {
		const fake = makeFakeRuntime();
		(fake.runtime as unknown as { getService: () => null }).getService = () =>
			null;

		await expect(
			userPersonalityProvider.get(
				fake.runtime,
				messageFor(fake.runtime.agentId),
				emptyState,
			),
		).resolves.toEqual({ text: "", values: {}, data: {} });
	});

	test("short-circuits agent self-messages before any lookup", async () => {
		const fake = makeFakeRuntime();
		(
			fake.runtime as unknown as { getMemories: () => Promise<never> }
		).getMemories = async () => {
			throw new Error("must not be called");
		};
		const selfMessage = makeMessage({
			entityId: fake.runtime.agentId,
			agentId: fake.runtime.agentId,
			text: "internal",
		});

		await expect(
			userPersonalityProvider.get(fake.runtime, selfMessage, emptyState),
		).resolves.toEqual({ text: "", values: {}, data: {} });
	});
});
