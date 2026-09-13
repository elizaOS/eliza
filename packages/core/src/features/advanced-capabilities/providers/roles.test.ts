/**
 * Unit tests for the ROLES provider's entity resolution. The runtime is an
 * in-memory double; entity lookups are held at an explicit gate so the
 * admission bound can be measured before any lookup completes.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.js";
import { ChannelType } from "../../../types/index.js";
import { roleProvider } from "./roles.js";

describe("roleProvider", () => {
	const roomId = "room-1" as UUID;
	const worldId = "world-1" as UUID;
	const dummyMessage = { roomId } as Memory;
	const dummyState = { data: {} } as unknown as State;

	it("bounds concurrent entity lookups while still listing every role holder (#30896)", async () => {
		const memberCount = 64;
		const roles: Record<string, string> = {};
		for (let i = 0; i < memberCount; i += 1) {
			roles[`entity-${i}`] = i === 0 ? "OWNER" : i < 4 ? "ADMIN" : "NONE";
		}
		let inFlight = 0;
		let peakInFlight = 0;
		const releases: Array<() => void> = [];
		const runtime = {
			agentId: "agent-1" as UUID,
			getRoom: vi.fn().mockResolvedValue({
				id: roomId,
				type: ChannelType.GROUP,
				worldId,
			}),
			getWorld: vi.fn().mockResolvedValue({
				id: worldId,
				metadata: { ownership: { ownerId: "entity-0" }, roles },
			}),
			getEntityById: vi.fn(async (id: string) => {
				inFlight += 1;
				peakInFlight = Math.max(peakInFlight, inFlight);
				await new Promise<void>((resolve) => {
					releases.push(resolve);
				});
				inFlight -= 1;
				return {
					id,
					names: [`Name ${id}`],
					metadata: { username: `user-${id}` },
				};
			}),
		} as unknown as IAgentRuntime;

		const pending = roleProvider.get(runtime, dummyMessage, dummyState);

		// Drain the gate until every lookup has been admitted and released.
		let released = 0;
		while (released < memberCount) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			while (releases.length > 0) {
				releases.shift()?.();
				released += 1;
			}
		}
		const result = await pending;

		expect(runtime.getEntityById).toHaveBeenCalledTimes(memberCount);
		expect(peakInFlight).toBe(8);
		expect(result.text).toContain("## Owners\nName entity-0 (Name entity-0)");
		expect(result.text).toContain("## Administrators");
		expect(result.text).toContain("## Members");
		for (let i = 0; i < memberCount; i += 1) {
			expect(result.text).toContain(`Name entity-${i} (Name entity-${i})`);
		}
	});
});
