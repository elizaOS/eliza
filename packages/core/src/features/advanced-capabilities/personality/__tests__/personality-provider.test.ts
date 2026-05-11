import { beforeEach, describe, expect, test } from "vitest";
import type { State, UUID } from "../../../../types/index.ts";
import { userPersonalityProvider } from "../providers/user-personality.ts";
import { GLOBAL_PERSONALITY_SCOPE } from "../types.ts";
import { initStore, makeFakeRuntime, makeMessage } from "./test-helpers.ts";

const emptyState: State = { values: {}, data: {}, text: "" };

describe("userPersonalityProvider", () => {
	let fake: ReturnType<typeof makeFakeRuntime>;
	beforeEach(async () => {
		fake = makeFakeRuntime();
		await initStore(fake);
	});

	test("returns empty when no slots are set", async () => {
		const message = makeMessage({
			entityId: "00000000-0000-4000-8000-0000000000fa" as UUID,
			agentId: fake.runtime.agentId,
			text: "hi",
		});
		const result = await userPersonalityProvider.get(
			fake.runtime,
			message,
			emptyState,
		);
		expect(result.text).toBe("");
	});

	test("renders structured user slot when present", async () => {
		const userId = "00000000-0000-4000-8000-0000000000fb" as UUID;
		fake.store.applyTrait({
			scope: "user",
			userId,
			agentId: fake.runtime.agentId,
			actorId: userId,
			trait: "verbosity",
			value: "terse",
		});
		fake.store.applyTrait({
			scope: "user",
			userId,
			agentId: fake.runtime.agentId,
			actorId: userId,
			trait: "tone",
			value: "direct",
		});
		fake.store.addDirective({
			userId,
			agentId: fake.runtime.agentId,
			actorId: userId,
			directive: "no emojis",
		});
		const message = makeMessage({
			entityId: userId,
			agentId: fake.runtime.agentId,
			text: "hi",
		});
		const result = await userPersonalityProvider.get(
			fake.runtime,
			message,
			emptyState,
		);
		expect(result.text).toContain("[PERSONALITY for THIS user]");
		expect(result.text).toContain("verbosity: terse");
		expect(result.text).toContain("tone: direct");
		expect(result.text).toContain("no emojis");
	});

	test("renders global slot too, distinct from user slot", async () => {
		const userId = "00000000-0000-4000-8000-0000000000fc" as UUID;
		fake.store.applyTrait({
			scope: "global",
			userId,
			agentId: fake.runtime.agentId,
			actorId: userId,
			trait: "formality",
			value: "casual",
		});
		const message = makeMessage({
			entityId: userId,
			agentId: fake.runtime.agentId,
			text: "hi",
		});
		const result = await userPersonalityProvider.get(
			fake.runtime,
			message,
			emptyState,
		);
		expect(result.text).toContain("[GLOBAL PERSONALITY]");
		expect(result.text).toContain("formality: casual");
	});

	test("skips block for agent self-messages", async () => {
		const message = makeMessage({
			entityId: fake.runtime.agentId,
			agentId: fake.runtime.agentId,
			text: "self message",
		});
		const result = await userPersonalityProvider.get(
			fake.runtime,
			message,
			emptyState,
		);
		expect(result.text).toBe("");
	});

	test("omits reply_gate=always from the rendered block", async () => {
		const userId = "00000000-0000-4000-8000-0000000000fd" as UUID;
		fake.store.applyReplyGate({
			scope: "user",
			userId,
			agentId: fake.runtime.agentId,
			actorId: userId,
			mode: "always",
		});
		const message = makeMessage({
			entityId: userId,
			agentId: fake.runtime.agentId,
			text: "hi",
		});
		const result = await userPersonalityProvider.get(
			fake.runtime,
			message,
			emptyState,
		);
		// reply_gate=always is the default — don't pollute the prompt
		expect(result.text).not.toContain("reply_gate: always");
	});

	test("renders reply_gate when non-default", async () => {
		const userId = "00000000-0000-4000-8000-0000000000fe" as UUID;
		fake.store.applyReplyGate({
			scope: "user",
			userId,
			agentId: fake.runtime.agentId,
			actorId: userId,
			mode: "never_until_lift",
		});
		const message = makeMessage({
			entityId: userId,
			agentId: fake.runtime.agentId,
			text: "hi",
		});
		const result = await userPersonalityProvider.get(
			fake.runtime,
			message,
			emptyState,
		);
		expect(result.text).toContain("reply_gate: never_until_lift");
	});
});

describe("userPersonalityProvider — backward compatibility", () => {
	test("still renders legacy free-text preferences alongside structured slot", async () => {
		const fake = makeFakeRuntime();
		await initStore(fake);
		const userId = "00000000-0000-4000-8000-000000000aff" as UUID;

		// Seed a legacy preference memory
		await fake.runtime.createMemory(
			{
				entityId: userId,
				roomId: fake.runtime.agentId,
				content: {
					text: "respond in Spanish",
					source: "user_personality_preference",
				},
			} as never,
			"user_personality_preferences",
		);

		fake.store.applyTrait({
			scope: "user",
			userId,
			agentId: fake.runtime.agentId,
			actorId: userId,
			trait: "verbosity",
			value: "terse",
		});

		const message = makeMessage({
			entityId: userId,
			agentId: fake.runtime.agentId,
			text: "hi",
		});
		const result = await userPersonalityProvider.get(
			fake.runtime,
			message,
			emptyState,
		);
		expect(result.text).toContain("[USER INTERACTION PREFERENCES]");
		expect(result.text).toContain("respond in Spanish");
		expect(result.text).toContain("verbosity: terse");
	});
});
