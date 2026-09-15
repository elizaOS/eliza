/**
 * Regression suite for #29168: leading @ strip in resolveAddressedTargets byName map.
 * Ensures platform handles stored with leading @ resolve correctly for both
 * non-agent participants and the agent's own entity alias, prevents room
 * participants from colliding with the agent's name, and verifies silence
 * gate pass-through.
 */
import { describe, expect, it } from "vitest";
import type { Entity, IAgentRuntime, Memory, UUID } from "../types/index";
import {
	messageAddressedToOtherParticipant,
	resolveAddressedTargets,
} from "./addressed-to";

describe("resolveAddressedTargets", () => {
	it("resolves entity names that include a leading @ (e.g. platform handles)", async () => {
		const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
		const participantId = "00000000-0000-0000-0000-000000000002" as UUID;

		const runtime = {
			agentId,
			character: { name: "Agent" },
			getEntitiesForRoom: async () => [
				{
					id: participantId,
					names: ["@sol_eth", "Sol"],
				} as Entity,
			],
		} as unknown as IAgentRuntime;

		const message = {
			roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		} as Memory;

		// 1. Lookup with '@'
		const resolvedWithAt = await resolveAddressedTargets({
			runtime,
			message,
			addressedTo: ["@sol_eth"],
		});
		expect(resolvedWithAt).toEqual([participantId]);

		// 2. Lookup without '@'
		const resolvedWithoutAt = await resolveAddressedTargets({
			runtime,
			message,
			addressedTo: ["sol_eth"],
		});
		expect(resolvedWithoutAt).toEqual([participantId]);
	});

	it("resolves agent entity stored alias with leading @ and does not gate turn", async () => {
		// Issue #29168 acceptance criterion:
		// When the agent's own entity in getEntitiesForRoom has an alias like '@samantha_ai_bot',
		// both '@samantha_ai_bot' and 'samantha_ai_bot' must resolve to runtime.agentId.
		// Furthermore, messageAddressedToOtherParticipant must return false (turn not suppressed).
		const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
		const speakerId = "00000000-0000-0000-0000-000000000002" as UUID;
		const roomId = "00000000-0000-0000-0000-000000000003" as UUID;

		const agentEntity: Entity = {
			id: agentId,
			names: ["@samantha_ai_bot", "Samantha"],
		} as Entity;

		const runtime = {
			agentId,
			character: { name: "Samantha" },
			getEntitiesForRoom: async () => [agentEntity],
		} as unknown as IAgentRuntime;

		const message: Memory = {
			roomId,
			entityId: speakerId,
			content: { text: "hey @samantha_ai_bot what is the weather?" },
		} as unknown as Memory;

		// 1. resolveAddressedTargets with '@'
		const resolvedWithAt = await resolveAddressedTargets({
			runtime,
			message,
			addressedTo: ["@samantha_ai_bot"],
		});
		expect(resolvedWithAt).toEqual([agentId]);

		// 2. resolveAddressedTargets without '@'
		const resolvedWithoutAt = await resolveAddressedTargets({
			runtime,
			message,
			addressedTo: ["samantha_ai_bot"],
		});
		expect(resolvedWithoutAt).toEqual([agentId]);

		// 3. messageAddressedToOtherParticipant must be false (self-addressed)
		const isOther = await messageAddressedToOtherParticipant({
			runtime,
			message,
			addressedTo: ["@samantha_ai_bot"],
		});
		expect(isOther).toBe(false);
	});

	it("agent name wins over participant with the same @-stripped key (collision guard)", async () => {
		// Regression: when a participant carries the handle '@Eliza' and the agent's
		// character.name is 'Eliza', stripping '@' collapses both to the same byName
		// key. The agent's entry must win regardless of entity iteration order, so
		// that 'hey Eliza' resolves to the agent — not to the participant — and the
		// silence gate is NOT triggered.
		const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
		const participantId = "00000000-0000-0000-0000-000000000099" as UUID;

		const makeRuntime = (entityOrder: Entity[]) =>
			({
				agentId,
				character: { name: "Eliza" },
				getEntitiesForRoom: async () => entityOrder,
			}) as unknown as IAgentRuntime;

		const message = {
			roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		} as Memory;

		const attackerEntity: Entity = {
			id: participantId,
			names: ["@Eliza"],
		} as Entity;

		const agentEntity: Entity = {
			id: agentId,
			names: ["Eliza"],
		} as Entity;

		// Order A: agent entity listed FIRST, then attacker
		const runtimeAgentFirst = makeRuntime([agentEntity, attackerEntity]);
		// Order B: attacker listed FIRST, then agent
		const runtimeAttackerFirst = makeRuntime([attackerEntity, agentEntity]);

		// Both orderings must resolve to the agent
		const resultAgentFirst = await resolveAddressedTargets({
			runtime: runtimeAgentFirst,
			message,
			addressedTo: ["Eliza"],
		});
		expect(resultAgentFirst).toEqual([agentId]);

		const resultAttackerFirst = await resolveAddressedTargets({
			runtime: runtimeAttackerFirst,
			message,
			addressedTo: ["Eliza"],
		});
		expect(resultAttackerFirst).toEqual([agentId]);

		// Also verify with the '@'-prefixed form
		const resultWithAt = await resolveAddressedTargets({
			runtime: runtimeAttackerFirst,
			message,
			addressedTo: ["@Eliza"],
		});
		expect(resultWithAt).toEqual([agentId]);
	});

	it("resolves stored handle with leading/trailing whitespace correctly", async () => {
		const participantId = "00000000-0000-0000-0000-000000000042" as UUID;
		const runtime = {
			agentId: "00000000-0000-0000-0000-000000000001" as UUID,
			character: { name: "Agent" },
			getEntitiesForRoom: async () => [
				{
					id: participantId,
					names: [" @sol_eth ", " @ ", "@"],
				} as Entity,
			],
		} as unknown as IAgentRuntime;

		const message = {
			roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		} as Memory;

		const resolved = await resolveAddressedTargets({
			runtime,
			message,
			addressedTo: ["sol_eth"],
		});
		expect(resolved).toEqual([participantId]);

		const resolvedLookupAt = await resolveAddressedTargets({
			runtime,
			message,
			addressedTo: ["@sol_eth"],
		});
		expect(resolvedLookupAt).toEqual([participantId]);

		const emptyLookup = await resolveAddressedTargets({
			runtime,
			message,
			addressedTo: ["@", " @ "],
		});
		expect(emptyLookup).toEqual([]);
	});
});
