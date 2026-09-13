import { describe, expect, it } from "vitest";
import { resolveAddressedTargets } from "./addressed-to";
import type { Entity, IAgentRuntime, Memory, UUID } from "../../types/index";

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
});
