import { describe, expect, test, vi } from "vitest";
import {
	OPTIMIZED_PROMPT_SERVICE,
	type OptimizedPromptArtifact,
	OptimizedPromptService,
} from "../../services/optimized-prompt";
import type { IAgentRuntime, Memory, UUID } from "../../types";
import { AutonomyService } from "./service";

function makeOptimizedAutonomyService(prompt: string): OptimizedPromptService {
	const service = new OptimizedPromptService();
	service.setDisabledTasksFromEnv(undefined);
	const direct = service as unknown as {
		cache: {
			autonomy?: { artifact: OptimizedPromptArtifact; loadedAt: number };
		};
	};
	direct.cache.autonomy = {
		artifact: {
			task: "autonomy",
			optimizer: "gepa",
			baseline: "BASELINE {{targetRoomContext}} {{lastThought}}",
			prompt,
			score: 0.9,
			baselineScore: 0.5,
			datasetId: "autonomy-test",
			datasetSize: 4,
			generatedAt: "2026-05-20T00:00:00.000Z",
			lineage: [{ round: 1, variant: 0, score: 0.9 }],
		},
		loadedAt: Date.now(),
	};
	return service;
}

describe("AutonomyService optimized prompt integration", () => {
	test("fills the GEPA-optimized autonomy prompt when an autonomy artifact is loaded", () => {
		const optimizedPromptService = makeOptimizedAutonomyService(
			"GEPA autonomy prompt\ncontext={{targetRoomContext}}\nlast={{lastThought}}",
		);
		const service = new AutonomyService();
		(service as unknown as { runtime: IAgentRuntime }).runtime = {
			getService<T>(name: string): T | null {
				if (name === OPTIMIZED_PROMPT_SERVICE) {
					return optimizedPromptService as T;
				}
				return null;
			},
		} as unknown as IAgentRuntime;

		const output = (
			service as unknown as {
				fillAutonomyTemplate: (
					template: string,
					values: { targetRoomContext: string; lastThought: string },
				) => string;
			}
		).fillAutonomyTemplate("baseline {{targetRoomContext}} {{lastThought}}", {
			targetRoomContext: "room context",
			lastThought: "prior note",
		});

		expect(output).toBe(
			"GEPA autonomy prompt\ncontext=room context\nlast=prior note",
		);
	});

	test("compacts older autonomous thoughts and caches the compacted section", async () => {
		const service = new AutonomyService();
		const agentId = "00000000-0000-0000-0000-000000000020" as UUID;
		const cache = new Map<string, unknown>();
		(service as unknown as { runtime: IAgentRuntime }).runtime = {
			agentId,
			getCache: async <T>(key: string): Promise<T | undefined> =>
				cache.get(key) as T | undefined,
			setCache: async (key: string, value: unknown): Promise<boolean> => {
				cache.set(key, value);
				return true;
			},
		} as unknown as IAgentRuntime;

		const memories = Array.from({ length: 18 }, (_, index) => ({
			id: `00000000-0000-0000-0000-${String(index + 100).padStart(
				12,
				"0",
			)}` as UUID,
			entityId: agentId,
			agentId,
			roomId: "00000000-0000-0000-0000-000000000021" as UUID,
			createdAt: 1_700_000_000_000 + index,
			content: {
				text:
					index === 0
						? "standing goal: keep working on the Cerebras autonomy proof"
						: `autonomous loop thought ${index}`,
				metadata: {
					type: "autonomous-response",
					isAutonomous: true,
				},
			},
		})) satisfies Memory[];

		const harness = service as unknown as {
			buildCompactedAutonomyThoughtSection: (
				memories: Memory[],
			) => Promise<string>;
			getAutonomyCompactionStats: () => {
				cacheHits: number;
				cacheWrites: number;
				compactions: number;
				lastSourceCount: number;
			};
		};

		const first = await harness.buildCompactedAutonomyThoughtSection(memories);
		const firstStats = harness.getAutonomyCompactionStats();
		const second = await harness.buildCompactedAutonomyThoughtSection(memories);
		const secondStats = harness.getAutonomyCompactionStats();

		expect(first).toContain("Compacted autonomous context:");
		expect(first).toContain("Compacted 8 prior autonomous thoughts");
		expect(first).toContain("standing goal: keep working");
		expect(first).toContain("Recent autonomous thoughts:");
		expect(first).toContain("autonomous loop thought 17");
		expect(firstStats).toMatchObject({
			compactions: 1,
			cacheWrites: 1,
			cacheHits: 0,
			lastSourceCount: 8,
		});
		expect(second).toBe(first);
		expect(secondStats).toMatchObject({
			compactions: 1,
			cacheWrites: 1,
			cacheHits: 1,
			lastSourceCount: 8,
		});
	});

	test("does not scan every participant room without explicit autonomy opt-in", async () => {
		const service = new AutonomyService();
		const getRoomsForParticipant = vi.fn(async () => {
			throw new Error("should not enumerate rooms by default");
		});
		(service as unknown as { runtime: IAgentRuntime }).runtime = {
			agentId: "00000000-0000-0000-0000-000000000020" as UUID,
			getSetting: () => null,
			getRoomsForParticipant,
			getMemories: async () => [],
		} as unknown as IAgentRuntime;

		const output = await (
			service as unknown as {
				getTargetRoomContextText: () => Promise<string>;
			}
		).getTargetRoomContextText();

		expect(getRoomsForParticipant).not.toHaveBeenCalled();
		expect(output).toContain("no AUTONOMY_TARGET_ROOM_ID configured");
		expect(output).toContain("Autonomous thoughts: (none)");
	});
});
