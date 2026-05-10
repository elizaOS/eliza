import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createJsonFileTrajectoryRecorder,
	type RecordedStage,
	type RecordedTrajectory,
} from "../trajectory-recorder";

let tmpDir: string;
const originalReviewMode = process.env.MILADY_TRAJECTORY_REVIEW_MODE;
const originalMarkdownDir = process.env.MILADY_TRAJECTORY_MARKDOWN_DIR;
const originalCerebrasKey = process.env.CEREBRAS_API_KEY;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "trajectory-recorder-test-"),
	);
	delete process.env.MILADY_TRAJECTORY_REVIEW_MODE;
	delete process.env.MILADY_TRAJECTORY_MARKDOWN_DIR;
	delete process.env.CEREBRAS_API_KEY;
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
	if (originalReviewMode === undefined) {
		delete process.env.MILADY_TRAJECTORY_REVIEW_MODE;
	} else {
		process.env.MILADY_TRAJECTORY_REVIEW_MODE = originalReviewMode;
	}
	if (originalMarkdownDir === undefined) {
		delete process.env.MILADY_TRAJECTORY_MARKDOWN_DIR;
	} else {
		process.env.MILADY_TRAJECTORY_MARKDOWN_DIR = originalMarkdownDir;
	}
	if (originalCerebrasKey === undefined) {
		delete process.env.CEREBRAS_API_KEY;
	} else {
		process.env.CEREBRAS_API_KEY = originalCerebrasKey;
	}
});

describe("JsonFileTrajectoryRecorder", () => {
	it("startTrajectory + recordStage + endTrajectory produces a JSON file with the §18.1 shape", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-test",
			roomId: "room-1",
			rootMessage: { id: "msg-1", text: "hello", sender: "user-1" },
		});

		const messageHandler: RecordedStage = {
			stageId: "stage-msghandler-1",
			kind: "messageHandler",
			startedAt: 1_000,
			endedAt: 1_300,
			latencyMs: 300,
			model: {
				modelType: "RESPONSE_HANDLER",
				modelName: "gpt-oss-120b",
				provider: "cerebras",
				prompt: "system: hi\nuser: hello",
				response: '{"action":"RESPOND","contexts":["calendar"]}',
				usage: {
					promptTokens: 1000,
					completionTokens: 50,
					cacheReadInputTokens: 800,
					totalTokens: 1050,
				},
			},
		};
		await recorder.recordStage(id, messageHandler);

		const planner: RecordedStage = {
			stageId: "stage-planner-iter-1",
			kind: "planner",
			iteration: 1,
			startedAt: 1_400,
			endedAt: 2_000,
			latencyMs: 600,
			model: {
				modelType: "ACTION_PLANNER",
				modelName: "gpt-oss-120b",
				provider: "cerebras",
				prompt: "planner prompt",
				response: "",
				toolCalls: [{ id: "call-1", name: "WEB_SEARCH", args: { q: "eliza" } }],
				tools: [{ name: "WEB_SEARCH", description: "Search the web" }],
				toolChoice: "auto",
				usage: {
					promptTokens: 1500,
					completionTokens: 80,
					cacheReadInputTokens: 1000,
					totalTokens: 1580,
				},
			},
		};
		await recorder.recordStage(id, planner);

		const tool: RecordedStage = {
			stageId: "stage-tool-WEB_SEARCH",
			kind: "tool",
			startedAt: 2_010,
			endedAt: 2_120,
			latencyMs: 110,
			tool: {
				name: "WEB_SEARCH",
				args: { q: "eliza" },
				result: { hits: 3 },
				success: true,
				durationMs: 110,
			},
		};
		await recorder.recordStage(id, tool);

		const evaluation: RecordedStage = {
			stageId: "stage-eval-iter-1",
			kind: "evaluation",
			iteration: 1,
			startedAt: 2_130,
			endedAt: 2_400,
			latencyMs: 270,
			model: {
				modelType: "RESPONSE_HANDLER",
				modelName: "gpt-oss-120b",
				provider: "cerebras",
				prompt: "evaluator prompt",
				response: '{"success":true,"decision":"FINISH"}',
				usage: {
					promptTokens: 1700,
					completionTokens: 40,
					totalTokens: 1740,
				},
			},
			evaluation: {
				success: true,
				decision: "FINISH",
				thought: "Done.",
			},
		};
		await recorder.recordStage(id, evaluation);

		await recorder.endTrajectory(id, "finished");

		// File location: <root>/<agentId>/<id>.json
		const filePath = path.join(tmpDir, "agent-test", `${id}.json`);
		const raw = await fs.readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as RecordedTrajectory;

		expect(parsed.trajectoryId).toBe(id);
		expect(parsed.agentId).toBe("agent-test");
		expect(parsed.roomId).toBe("room-1");
		expect(parsed.rootMessage).toEqual({
			id: "msg-1",
			text: "hello",
			sender: "user-1",
		});
		expect(parsed.status).toBe("finished");
		expect(parsed.stages).toHaveLength(4);
		expect(parsed.stages[0]?.kind).toBe("messageHandler");
		expect(parsed.stages[1]?.kind).toBe("planner");
		expect(parsed.stages[2]?.kind).toBe("tool");
		expect(parsed.stages[3]?.kind).toBe("evaluation");

		// Metrics roll-up
		expect(parsed.metrics.plannerIterations).toBe(1);
		expect(parsed.metrics.toolCallsExecuted).toBe(1);
		expect(parsed.metrics.toolCallFailures).toBe(0);
		expect(parsed.metrics.evaluatorFailures).toBe(0);
		expect(parsed.metrics.totalPromptTokens).toBe(1000 + 1500 + 1700);
		expect(parsed.metrics.totalCompletionTokens).toBe(50 + 80 + 40);
		expect(parsed.metrics.totalCacheReadTokens).toBe(800 + 1000);
		expect(parsed.metrics.finalDecision).toBe("FINISH");
		expect(parsed.metrics.totalLatencyMs).toBe(300 + 600 + 110 + 270);
	});

	it("does not count an interim CONTINUE evaluation as an evaluator failure", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-fail",
			rootMessage: { id: "msg-fail", text: "this will fail" },
		});

		await recorder.recordStage(id, {
			stageId: "stage-tool",
			kind: "tool",
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
			tool: {
				name: "BROKEN",
				args: {},
				result: { error: "boom" },
				success: false,
				durationMs: 1,
			},
		});

		await recorder.recordStage(id, {
			stageId: "stage-eval",
			kind: "evaluation",
			iteration: 1,
			startedAt: 3,
			endedAt: 4,
			latencyMs: 1,
			evaluation: {
				success: false,
				decision: "CONTINUE",
				thought: "tool failed",
			},
		});

		await recorder.endTrajectory(id, "finished");

		const trajectory = await recorder.load(id);
		expect(trajectory).not.toBeNull();
		expect(trajectory?.metrics.evaluatorFailures).toBe(0);
		expect(trajectory?.metrics.toolCallFailures).toBe(1);
	});

	it("does not count terminal task failure as evaluator failure", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-terminal-fail",
			rootMessage: { id: "msg-terminal-fail", text: "missing input" },
		});

		await recorder.recordStage(id, {
			stageId: "stage-eval-terminal-fail",
			kind: "evaluation",
			iteration: 1,
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
			evaluation: {
				success: false,
				decision: "FINISH",
				thought: "cannot proceed without user input",
			},
		});

		await recorder.endTrajectory(id, "finished");

		const trajectory = await recorder.load(id);
		expect(trajectory).not.toBeNull();
		expect(trajectory?.metrics.evaluatorFailures).toBe(0);
		expect(trajectory?.metrics.finalDecision).toBe("FINISH");
	});

	it("counts evaluator parse errors as evaluator failures", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-eval-parse-fail",
			rootMessage: { id: "msg-eval-parse-fail", text: "bad eval output" },
		});

		await recorder.recordStage(id, {
			stageId: "stage-eval-parse-fail",
			kind: "evaluation",
			iteration: 1,
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
			evaluation: {
				success: false,
				decision: "CONTINUE",
				thought: "Invalid evaluator output: response is not JSON.",
				parseError: "response is not JSON",
			},
		});

		await recorder.endTrajectory(id, "finished");

		const trajectory = await recorder.load(id);
		expect(trajectory).not.toBeNull();
		expect(trajectory?.metrics.evaluatorFailures).toBe(1);
		expect(trajectory?.metrics.finalDecision).toBe("CONTINUE");
	});

	it("computes costUsd via the price table when usage and modelName are set", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-cost",
			rootMessage: { id: "msg", text: "test" },
		});

		await recorder.recordStage(id, {
			stageId: "stage-1",
			kind: "planner",
			iteration: 1,
			startedAt: 0,
			endedAt: 100,
			latencyMs: 100,
			model: {
				modelType: "ACTION_PLANNER",
				modelName: "gpt-oss-120b",
				provider: "cerebras",
				prompt: "p",
				response: "r",
				usage: {
					promptTokens: 1_000_000,
					completionTokens: 1_000_000,
					totalTokens: 2_000_000,
				},
			},
		});
		await recorder.endTrajectory(id, "finished");

		const trajectory = await recorder.load(id);
		expect(trajectory?.stages[0]?.model?.costUsd).toBeCloseTo(1.3, 6);
		expect(trajectory?.metrics.totalCostUsd).toBeCloseTo(1.3, 6);
	});

	it("marks trajectories as errored when endTrajectory is called with errored", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-error",
			rootMessage: { id: "msg", text: "x" },
		});
		await recorder.endTrajectory(id, "errored");
		const trajectory = await recorder.load(id);
		expect(trajectory?.status).toBe("errored");
		expect(trajectory?.metrics.finalDecision).toBe("error");
	});

	it("list returns trajectories sorted by startedAt desc and respects filters", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const a = recorder.startTrajectory({
			agentId: "agent-a",
			rootMessage: { id: "1", text: "a" },
		});
		await recorder.endTrajectory(a, "finished");

		// Small delay to ensure deterministic startedAt ordering.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const b = recorder.startTrajectory({
			agentId: "agent-b",
			rootMessage: { id: "2", text: "b" },
		});
		await recorder.endTrajectory(b, "finished");

		const all = await recorder.list();
		expect(all).toHaveLength(2);
		// Newest first.
		expect(all[0]?.trajectoryId).toBe(b);

		const onlyA = await recorder.list({ agentId: "agent-a" });
		expect(onlyA).toHaveLength(1);
		expect(onlyA[0]?.trajectoryId).toBe(a);
	});

	it("disabled recorder returns no-op for every method (does not write any files)", async () => {
		const recorder = createJsonFileTrajectoryRecorder({
			rootDir: tmpDir,
			enabled: false,
		});
		const id = recorder.startTrajectory({
			agentId: "noop",
			rootMessage: { id: "0", text: "n" },
		});
		await recorder.recordStage(id, {
			stageId: "ignored",
			kind: "planner",
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
		});
		await recorder.endTrajectory(id, "finished");

		// No files should have been written.
		const entries = await fs.readdir(tmpDir).catch(() => [] as string[]);
		expect(entries).toEqual([]);
	});

	it("writes redacted markdown review artifacts when review mode is enabled", async () => {
		process.env.MILADY_TRAJECTORY_REVIEW_MODE = "1";
		process.env.CEREBRAS_API_KEY = "csk-secret-for-markdown-test";

		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-md",
			rootMessage: {
				id: "msg-md",
				text: "use csk-secret-for-markdown-test",
			},
		});
		await recorder.recordStage(id, {
			stageId: "stage-md",
			kind: "planner",
			startedAt: 100,
			endedAt: 200,
			latencyMs: 100,
			model: {
				modelType: "ACTION_PLANNER",
				modelName: "gpt-oss-120b",
				provider: "cerebras",
				prompt: "prompt with csk-secret-for-markdown-test",
				response: "done",
			},
		});
		await recorder.endTrajectory(id, "finished");

		const markdownPath = path.join(tmpDir, "agent-md", `${id}.md`);
		const markdown = await fs.readFile(markdownPath, "utf8");
		expect(markdown).toContain(`# Trajectory ${id}`);
		expect(markdown).toContain("## Stage 1: planner");
		expect(markdown).toContain("[REDACTED_SECRET]");
		expect(markdown).not.toContain("csk-secret-for-markdown-test");
	});

	it("output JSON is structurally compatible with scripts/run-cerebras.ts LocalRecorder", async () => {
		// Smoke test: produce a minimal trajectory and assert every top-level
		// field expected by the schema in PLAN.md §18.1 is present and typed.
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-smoke",
			roomId: "room-smoke",
			rootMessage: { id: "msg-smoke", text: "smoke", sender: "shaw" },
		});
		await recorder.recordStage(id, {
			stageId: "stage-msg",
			kind: "messageHandler",
			startedAt: 100,
			endedAt: 200,
			latencyMs: 100,
			model: {
				modelType: "RESPONSE_HANDLER",
				provider: "cerebras",
				prompt: "p",
				response: "r",
			},
		});
		await recorder.endTrajectory(id, "finished");

		const filePath = path.join(tmpDir, "agent-smoke", `${id}.json`);
		const parsed = JSON.parse(
			await fs.readFile(filePath, "utf8"),
		) as RecordedTrajectory;

		// Required top-level fields
		expect(typeof parsed.trajectoryId).toBe("string");
		expect(typeof parsed.agentId).toBe("string");
		expect(typeof parsed.startedAt).toBe("number");
		expect(typeof parsed.endedAt).toBe("number");
		expect(parsed.status).toBe("finished");
		expect(Array.isArray(parsed.stages)).toBe(true);
		expect(parsed.metrics).toBeDefined();
		expect(parsed.rootMessage).toEqual({
			id: "msg-smoke",
			text: "smoke",
			sender: "shaw",
		});

		// Required metric fields
		const m = parsed.metrics;
		expect(typeof m.totalLatencyMs).toBe("number");
		expect(typeof m.totalPromptTokens).toBe("number");
		expect(typeof m.totalCompletionTokens).toBe("number");
		expect(typeof m.totalCacheReadTokens).toBe("number");
		expect(typeof m.totalCacheCreationTokens).toBe("number");
		expect(typeof m.totalCostUsd).toBe("number");
		expect(typeof m.plannerIterations).toBe("number");
		expect(typeof m.toolCallsExecuted).toBe("number");
		expect(typeof m.toolCallFailures).toBe("number");
		expect(typeof m.evaluatorFailures).toBe("number");
	});
});
