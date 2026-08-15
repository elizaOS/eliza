/**
 * #17932: boot-time graph prewarm so cold rolodex turns hit the
 * stale-while-revalidate cache instead of awaiting a first build that adds
 * avoidable latency to provider composition.
 */
import { describe, expect, test } from "vitest";
import type { IAgentRuntime } from "../types/index";
import { createNativeRelationshipsGraphService } from "./relationships-graph-builder";

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function mockRuntime(options: { onWorlds: () => void }): IAgentRuntime {
	let worldsCalls = 0;
	return {
		agentId: "11111111-1111-4111-8111-111111111111",
		async getAllWorlds() {
			worldsCalls += 1;
			options.onWorlds();
			// Simulate a non-trivial first build without needing a real store.
			await sleep(30);
			return [];
		},
		async getRoomsByWorlds() {
			return [];
		},
		async getEntitiesForRoom() {
			return [];
		},
		async getRelationships() {
			return [];
		},
		async getEntityById() {
			return null;
		},
		getService() {
			return null;
		},
		_worldsCalls: () => worldsCalls,
	} as unknown as IAgentRuntime & { _worldsCalls: () => number };
}

describe("relationships graph prewarm (#17932)", () => {
	test("prewarmGraphModel starts a single-flight build shared with getGraphSnapshot", async () => {
		let worldsCalls = 0;
		const runtime = mockRuntime({
			onWorlds: () => {
				worldsCalls += 1;
			},
		});
		const service = createNativeRelationshipsGraphService(runtime, {
			async searchContacts() {
				return [];
			},
			async getCandidateMerges() {
				return [];
			},
		});

		// Kick background prewarm — must not throw and must not await.
		expect(() => service.prewarmGraphModel()).not.toThrow();
		// Second prewarm is a no-op while the build (or cache) is live.
		service.prewarmGraphModel();

		// Concurrent snapshot must share the single-flight build, not start a second.
		const snapshot = await service.getGraphSnapshot({ limit: 10 });
		expect(snapshot.people).toEqual([]);
		expect(worldsCalls).toBe(1);

		// Warm hit: no additional build.
		await service.getGraphSnapshot({ limit: 10 });
		expect(worldsCalls).toBe(1);
	});

	test("prewarm is a no-op once the model cache is populated", async () => {
		let worldsCalls = 0;
		const runtime = mockRuntime({
			onWorlds: () => {
				worldsCalls += 1;
			},
		});
		const service = createNativeRelationshipsGraphService(runtime, {
			async searchContacts() {
				return [];
			},
			async getCandidateMerges() {
				return [];
			},
		});

		await service.getGraphSnapshot({ limit: 5 });
		expect(worldsCalls).toBe(1);
		service.prewarmGraphModel();
		service.prewarmGraphModel();
		await sleep(10);
		expect(worldsCalls).toBe(1);
	});
});
