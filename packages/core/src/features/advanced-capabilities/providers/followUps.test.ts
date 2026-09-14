/**
 * Unit tests for the FOLLOW_UPS provider's contact-name resolution. The
 * runtime and FollowUpService are in-memory doubles; entity lookups are held
 * at an explicit gate so the admission bound can be measured before any
 * lookup completes.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.js";
import { followUpsProvider } from "./followUps.js";

describe("followUpsProvider", () => {
	const dummyMessage = { roomId: "room-1" as UUID } as Memory;
	const dummyState = {} as State;

	it("bounds concurrent entity lookups while still naming every contact (#30731)", async () => {
		const contactCount = 64;
		const followUps = Array.from({ length: contactCount }, (_unused, i) => ({
			task: {
				id: `task-${i}` as UUID,
				metadata: {
					scheduledAt: new Date(
						Date.now() + (i + 1) * 86_400_000,
					).toISOString(),
					reason: `reason ${i}`,
				},
			},
			contact: { entityId: `entity-${i}` as UUID },
		}));
		const followUpService = {
			getUpcomingFollowUps: vi.fn().mockResolvedValue(followUps),
			getFollowUpSuggestions: vi.fn().mockResolvedValue([]),
		};

		let inFlight = 0;
		let peakInFlight = 0;
		const releases: Array<() => void> = [];
		const runtime = {
			getService: vi.fn().mockReturnValue(followUpService),
			getEntityById: vi.fn(async (id: string) => {
				inFlight += 1;
				peakInFlight = Math.max(peakInFlight, inFlight);
				await new Promise<void>((resolve) => {
					releases.push(resolve);
				});
				inFlight -= 1;
				return { names: [`Name ${id}`] };
			}),
			logger: { warn: vi.fn(), error: vi.fn() },
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;

		const pending = followUpsProvider.get(runtime, dummyMessage, dummyState);

		// Drain the gate until every lookup has been admitted and released.
		let released = 0;
		while (released < contactCount) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			while (releases.length > 0) {
				releases.shift()?.();
				released += 1;
			}
		}
		const result = await pending;

		expect(runtime.getEntityById).toHaveBeenCalledTimes(contactCount);
		expect(peakInFlight).toBe(8);
		expect(result.values?.followUpCount).toBe(contactCount);
		for (let i = 0; i < contactCount; i += 1) {
			expect(result.text).toContain(`Name entity-${i}`);
		}
	});

	it("resolves each unique contact once and labels unknown entities", async () => {
		const followUps = [
			{
				task: {
					id: "t1" as UUID,
					metadata: { scheduledAt: new Date(0).toISOString() },
				},
				contact: { entityId: "e1" as UUID },
			},
			{
				task: { id: "t2" as UUID, metadata: {} },
				contact: { entityId: "e1" as UUID },
			},
			{
				task: { id: "t3" as UUID, metadata: {} },
				contact: { entityId: "e2" as UUID },
			},
		];
		const runtime = {
			getService: vi.fn().mockReturnValue({
				getUpcomingFollowUps: vi.fn().mockResolvedValue(followUps),
				getFollowUpSuggestions: vi.fn().mockResolvedValue([]),
			}),
			getEntityById: vi.fn(async (id: string) =>
				id === "e1" ? { names: ["Alice"] } : null,
			),
			logger: { warn: vi.fn(), error: vi.fn() },
			reportError: vi.fn(),
		} as unknown as IAgentRuntime;

		const result = await followUpsProvider.get(
			runtime,
			dummyMessage,
			dummyState,
		);

		expect(runtime.getEntityById).toHaveBeenCalledTimes(2);
		expect(result.text).toContain("Alice");
		expect(result.text).toContain("Unknown");
		expect(result.values?.followUpCount).toBe(3);
	});
});
