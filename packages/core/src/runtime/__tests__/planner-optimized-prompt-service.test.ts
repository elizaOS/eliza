/** Exercises the real planner request boundary with persisted artifacts and deterministic model output. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { plannerTemplate } from "../../prompts/planner";
import { OptimizedPromptService } from "../../services/optimized-prompt";
import { runPlannerLoop } from "../planner-loop";

const roots: string[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});

it("uses only the registered service and checks its baseline before a model request", async () => {
	const root = await mkdtemp(join(tmpdir(), "planner-artifact-contract-"));
	roots.push(root);
	vi.stubEnv("ELIZA_STATE_DIR", root);
	vi.stubEnv(
		"ELIZA_OPTIMIZED_PROMPT_HMAC_KEY",
		Buffer.alloc(32, 0x62).toString("base64"),
	);
	const store = join(root, "optimized-prompts");
	await mkdir(join(store, "action_planner"), { recursive: true });
	await writeFile(
		join(store, "action_planner", "old.json"),
		JSON.stringify({
			task: "action_planner",
			prompt: "INACTIVE_DISK_INSTRUCTION",
		}),
	);
	let service: OptimizedPromptService | null = null;
	const requests: string[] = [];
	const runtime = {
		getService: () => service,
		useModel: vi.fn(async (_type: string, params: object) => {
			requests.push(JSON.stringify(params));
			return {
				text: "Ready.",
				usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
			};
		}),
	};
	const run = () =>
		runPlannerLoop({
			runtime,
			context: { id: "artifact-consumer" },
			evaluate: async () => ({
				success: true,
				decision: "FINISH",
				messageToUser: "Ready.",
			}),
		});
	await run();
	expect(requests).toHaveLength(1);
	expect(requests[0]).not.toContain("INACTIVE_DISK_INSTRUCTION");
	service = new OptimizedPromptService();
	service.setStoreRoot(store);
	service.setDisabledTasksFromEnv(undefined);
	const artifact = {
		task: "action_planner" as const,
		optimizer: "instruction-search" as const,
		baseline: plannerTemplate,
		prompt: "ACTIVE_REVIEWED_INSTRUCTION",
		score: 0.7,
		baselineScore: 0.6,
		datasetId: "fixture",
		datasetSize: 1,
		generatedAt: "2026-09-15T00:00:00.000Z",
		lineage: [{ round: 1, variant: 0, score: 0.7 }],
	};
	await service.setPrompt("action_planner", artifact);
	await run();
	expect(requests[1]).toContain("ACTIVE_REVIEWED_INSTRUCTION");
	await service.setPrompt("action_planner", {
		...artifact,
		baseline: `${plannerTemplate}\nchanged`,
	});
	await expect(run()).rejects.toThrow("different baseline");
	expect(requests).toHaveLength(2);
});
