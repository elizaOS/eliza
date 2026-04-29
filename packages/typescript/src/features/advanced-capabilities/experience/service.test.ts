import { afterEach, describe, expect, it, vi } from "vitest";
import type { Memory, UUID } from "../../../types/index.ts";
import { ExperienceService } from "./service.ts";
import { ExperienceType, OutcomeType } from "./types.ts";
import { findDuplicateExperienceByLearning } from "./utils/experienceText.ts";

type RuntimeOverrides = {
	memories?: Memory[];
	embedding?: number[];
};

const activeServices: ExperienceService[] = [];

async function flushExperienceLoad(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function createServiceHarness(overrides: RuntimeOverrides = {}) {
	const getMemories = vi.fn(async () => overrides.memories ?? []);
	const upsertMemory = vi.fn(async () => undefined);
	const deleteMemory = vi.fn(async () => undefined);
	const useModel = vi.fn(async () => overrides.embedding ?? [0.12, 0.34, 0.56]);

	const runtime = {
		agentId: "agent-001" as UUID,
		getMemories,
		upsertMemory,
		deleteMemory,
		useModel,
	} as unknown as ConstructorParameters<typeof ExperienceService>[0];

	const service = new ExperienceService(runtime);
	activeServices.push(service);
	await flushExperienceLoad();

	return {
		service,
		getMemories,
		upsertMemory,
		deleteMemory,
		useModel,
	};
}

afterEach(async () => {
	while (activeServices.length > 0) {
		const service = activeServices.pop();
		if (service) {
			await service.stop();
		}
	}
});

describe("ExperienceService", () => {
	it("loads legacy raw experience memories into the canonical experience shape", async () => {
		const legacyMemory: Memory = {
			id: "legacy-exp-001" as UUID,
			entityId: "agent-001" as UUID,
			agentId: "agent-001" as UUID,
			roomId: "room-001" as UUID,
			content: {
				text: "Install dependencies before running the script.",
				type: "experience",
				context: "Shell session during local setup",
			},
			createdAt: 1_710_000_000_000,
		};

		const { service } = await createServiceHarness({
			memories: [legacyMemory],
		});

		const experiences = await service.listExperiences({ limit: 10 });
		expect(experiences).toHaveLength(1);
		expect(experiences[0]).toMatchObject({
			id: "legacy-exp-001",
			type: ExperienceType.LEARNING,
			outcome: OutcomeType.NEUTRAL,
			context: "Shell session during local setup",
			learning: "Install dependencies before running the script.",
			result: "Install dependencies before running the script.",
		});
	});

	it("persists canonical memories with embeddings and keeps list reads side-effect free", async () => {
		const { service, upsertMemory } = await createServiceHarness();

		const created = await service.recordExperience({
			type: ExperienceType.WARNING,
			outcome: OutcomeType.NEGATIVE,
			context: "Running the dev server",
			action: "bun run dev",
			result: "Missing dependency error",
			learning: "Install workspace dependencies before starting the app.",
			confidence: 0,
			importance: 0,
			tags: ["setup"],
			sourceMessageIds: ["msg-001" as UUID, "msg-002" as UUID],
			sourceRoomId: "room-001" as UUID,
			sourceTriggerMessageId: "msg-002" as UUID,
			sourceTrajectoryStepId: "trajectory-step-001",
			extractionMethod: "experience_evaluator",
			extractionReason: "The failed startup revealed a missing setup step.",
		});

		expect(created.confidence).toBe(0);
		expect(created.importance).toBe(0);
		expect(upsertMemory).toHaveBeenCalledTimes(1);
		expect(upsertMemory).toHaveBeenLastCalledWith(
			expect.objectContaining({
				id: created.id,
				unique: true,
				embedding: [0.12, 0.34, 0.56],
				content: expect.objectContaining({
					type: "experience",
					data: expect.objectContaining({
						id: created.id,
						learning: "Install workspace dependencies before starting the app.",
						keywords: expect.arrayContaining(["dependencies", "install"]),
						associatedEntityIds: [],
						sourceMessageIds: ["msg-001", "msg-002"],
						sourceRoomId: "room-001",
						sourceTriggerMessageId: "msg-002",
						sourceTrajectoryStepId: "trajectory-step-001",
						extractionMethod: "experience_evaluator",
						extractionReason:
							"The failed startup revealed a missing setup step.",
					}),
				}),
			}),
			"experiences",
		);

		const listed = await service.listExperiences({ limit: 10 });
		expect(listed[0]?.accessCount).toBe(0);

		const queried = await service.queryExperiences({ limit: 10 });
		expect(queried[0]?.accessCount).toBe(1);
		expect((await service.getExperience(created.id))?.accessCount).toBe(1);
	});

	it("updates and deletes experiences through the same persisted record id", async () => {
		const { service, upsertMemory, deleteMemory, useModel } =
			await createServiceHarness();

		const created = await service.recordExperience({
			context: "Initial context",
			action: "Initial action",
			result: "Initial result",
			learning: "Initial learning",
		});

		upsertMemory.mockClear();
		useModel.mockResolvedValueOnce([0.91, 0.82, 0.73]);

		const updated = await service.updateExperience(created.id, {
			learning: "Updated learning",
			domain: "shell",
			tags: ["shell", "setup"],
			previousBelief: undefined,
		});

		expect(updated).toMatchObject({
			id: created.id,
			learning: "Updated learning",
			domain: "shell",
			tags: ["shell", "setup"],
		});
		expect(upsertMemory).toHaveBeenCalledTimes(1);
		expect(upsertMemory).toHaveBeenLastCalledWith(
			expect.objectContaining({
				id: created.id,
				embedding: [0.91, 0.82, 0.73],
				content: expect.objectContaining({
					data: expect.objectContaining({
						learning: "Updated learning",
						domain: "shell",
						tags: ["shell", "setup"],
					}),
				}),
			}),
			"experiences",
		);

		await expect(service.deleteExperience(created.id)).resolves.toBe(true);
		expect(deleteMemory).toHaveBeenCalledWith(created.id);
		await expect(service.getExperience(created.id)).resolves.toBeNull();
	});

	it("builds graph nodes and inferred links from keywords and entities", async () => {
		const { service } = await createServiceHarness();

		await service.recordExperience({
			context: "Wallet swap request",
			action: "Collected route parameters",
			result: "Swap was prepared safely",
			learning:
				"Collect source token, destination token, amount, and slippage before swaps.",
			domain: "finance",
			keywords: ["wallet", "swap", "slippage"],
			associatedEntityIds: ["user-001" as UUID],
			confidence: 0.9,
			importance: 0.9,
		});
		await service.recordExperience({
			context: "Wallet route review",
			action: "Checked missing slippage",
			result: "The agent asked for confirmation",
			learning:
				"Wallet swaps need explicit slippage confirmation before execution.",
			domain: "finance",
			keywords: ["wallet", "swap", "slippage"],
			associatedEntityIds: ["user-001" as UUID],
			confidence: 0.8,
			importance: 0.8,
		});

		const graph = await service.getExperienceGraph({ limit: 10 });

		expect(graph.nodes).toHaveLength(2);
		expect(graph.nodes[0]).toMatchObject({
			keywords: expect.arrayContaining(["wallet", "swap"]),
			associatedEntityIds: expect.arrayContaining(["user-001"]),
		});
		expect(graph.links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "supports",
					keywords: expect.arrayContaining(["wallet", "swap", "slippage"]),
				}),
			]),
		);
	});

	it("consolidates duplicate experiences without destructive deletion by default", async () => {
		const { service, deleteMemory } = await createServiceHarness();

		const primary = await service.recordExperience({
			context: "Dependency setup",
			action: "Install workspace dependencies",
			result: "Dev server started",
			learning:
				"Install workspace dependencies before starting the app server.",
			domain: "system",
			keywords: ["dependencies", "workspace", "server"],
			confidence: 0.9,
			importance: 0.9,
		});
		const duplicate = await service.recordExperience({
			context: "Setup retry",
			action: "Install dependencies",
			result: "Startup worked",
			learning:
				"Install workspace dependencies before starting the app server.",
			domain: "system",
			keywords: ["dependencies", "startup"],
			confidence: 0.5,
			importance: 0.6,
		});

		const result = await service.consolidateDuplicateExperiences();

		expect(result).toMatchObject({
			inspected: 2,
			merged: 1,
			deleted: 0,
		});
		expect(deleteMemory).not.toHaveBeenCalled();
		const updatedPrimary = await service.getExperience(primary.id);
		const updatedDuplicate = await service.getExperience(duplicate.id);
		expect(updatedPrimary?.mergedExperienceIds).toContain(duplicate.id);
		expect(updatedPrimary?.keywords).toEqual(
			expect.arrayContaining(["dependencies", "startup"]),
		);
		expect(updatedDuplicate?.supersedes).toBe(primary.id);
		expect(updatedDuplicate?.confidence).toBeLessThanOrEqual(0.4);

		const secondPass = await service.consolidateDuplicateExperiences();
		expect(secondPass.merged).toBe(0);
	});

	it("finds duplicate learnings even when semantic search misses them", async () => {
		const { service } = await createServiceHarness();
		await service.recordExperience({
			context: "Local development after editing environment variables.",
			action: "manual seed",
			result:
				"Restart the Vite dev server after changing environment variables.",
			learning:
				"Restart the Vite dev server after changing environment variables so the process loads new config.",
			domain: "coding",
			confidence: 0.9,
			importance: 0.8,
		});
		vi.spyOn(service, "findSimilarExperiences").mockResolvedValueOnce([]);

		const duplicate = await findDuplicateExperienceByLearning(
			service,
			"Restarting the Vite dev server picks up the changed environment variable.",
		);

		expect(duplicate?.learning).toContain("Restart the Vite dev server");
	});
});
