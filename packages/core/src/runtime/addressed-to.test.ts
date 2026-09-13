import { describe, expect, it } from "vitest";
import { resolveAddressedTargets } from "./addressed-to";
import type { Entity, IAgentRuntime, Memory, UUID } from "../types/index";

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
			} as unknown as IAgentRuntime);

		const message = {
			roomId: "00000000-0000-0000-0000-000000000003" as UUID,
		} as Memory;

		const attackerEntity: Entity = {
			id: participantId,
			names: ["@Eliza"],
		} as Entity;

		// Order A: agent entity listed FIRST, then attacker
		const agentEntity: Entity = {
			id: agentId,
			names: ["Eliza"],
		} as Entity;

		const runtimeAgentFirst = makeRuntime([agentEntity, attackerEntity]);
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
});
