/** Exercises the real planner request boundary with persisted artifacts and deterministic model output. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	plannerBatchScopeDescription,
	plannerTemplate,
} from "../../prompts/planner";
import { OptimizedPromptService } from "../../services/optimized-prompt";
import { runPlannerLoop, TURN_SCOPE_ARG } from "../planner-loop";

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
	await service.restoreBaseline("action_planner");
	await run();
	expect(requests[2]).not.toContain("ACTIVE_REVIEWED_INSTRUCTION");
	service = new OptimizedPromptService();
	service.setStoreRoot(store);
	await service.refresh();
	await run();
	expect(requests[3]).not.toContain("ACTIVE_REVIEWED_INSTRUCTION");
	await service.setPrompt("action_planner", {
		...artifact,
		baseline: `${plannerTemplate}\nchanged`,
	});
	await expect(run()).rejects.toThrow("different baseline");
	expect(requests).toHaveLength(4);
});

it("states the batch-scope rule once for an optimized template that omits it and keeps the short pointer on every tool", async () => {
	const root = await mkdtemp(join(tmpdir(), "planner-batch-scope-backstop-"));
	roots.push(root);
	vi.stubEnv("ELIZA_STATE_DIR", root);
	vi.stubEnv(
		"ELIZA_OPTIMIZED_PROMPT_HMAC_KEY",
		Buffer.alloc(32, 0x62).toString("base64"),
	);
	const store = join(root, "optimized-prompts");
	await mkdir(join(store, "action_planner"), { recursive: true });
	const service = new OptimizedPromptService();
	service.setStoreRoot(store);
	service.setDisabledTasksFromEnv(undefined);
	await service.setPrompt("action_planner", {
		task: "action_planner",
		optimizer: "instruction-search",
		baseline: plannerTemplate,
		prompt: "OPTIMIZED_INSTRUCTION_WITHOUT_BATCH_SCOPE",
		score: 0.7,
		baselineScore: 0.6,
		datasetId: "fixture",
		datasetSize: 1,
		generatedAt: "2026-09-15T00:00:00.000Z",
		lineage: [{ round: 1, variant: 0, score: 0.7 }],
	});
	const requests: Array<{
		messages?: Array<{ role?: string; content?: unknown }>;
		tools?: Array<{
			name: string;
			parameters?: { properties?: Record<string, { description?: string }> };
		}>;
	}> = [];
	const runtime = {
		getService: () => service,
		useModel: vi.fn(async (_type: string, params: object) => {
			requests.push(params as (typeof requests)[number]);
			return {
				text: "Ready.",
				usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
			};
		}),
	};
	await runPlannerLoop({
		runtime,
		context: { id: "batch-scope-backstop" },
		tools: [
			{
				name: "SETTINGS",
				description: "Read or update a setting.",
				parameters: { type: "object", properties: {} },
			},
			{
				name: "REPLY",
				description: "Reply to the user.",
				parameters: { type: "object", properties: {} },
			},
		],
		evaluate: async () => ({
			success: true,
			decision: "FINISH",
			messageToUser: "Ready.",
		}),
	});
	expect(requests).toHaveLength(1);
	const system = requests[0]?.messages?.find(({ role }) => role === "system");
	expect(typeof system?.content).toBe("string");
	const instructions = system?.content as string;
	expect(instructions).toContain("OPTIMIZED_INSTRUCTION_WITHOUT_BATCH_SCOPE");
	expect(instructions).toContain("mandatory planner policy:");
	// The backstop states the rule exactly once, as the template's own bullet.
	expect(
		instructions.split(`- Batch scope: ${plannerBatchScopeDescription}`),
	).toHaveLength(2);
	// Every exposed tool now carries the short pointer, never the full protocol.
	const tools = requests[0]?.tools ?? [];
	expect(tools.map(({ name }) => name)).toEqual(["SETTINGS", "REPLY"]);
	for (const tool of tools) {
		const scope = tool.parameters?.properties?.[TURN_SCOPE_ARG];
		expect(scope?.description).toContain(
			"Follow the shared Batch scope instruction",
		);
		expect(scope?.description).not.toContain(plannerBatchScopeDescription);
	}
});
