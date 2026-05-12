import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyTrajectoryFieldCap,
	captureSkillInvocationIO,
	captureToolStageIO,
	createJsonFileTrajectoryRecorder,
	encodeTrajectoryFieldValue,
	type RecordedStage,
	type RecordedTrajectory,
	resolveTrajectoryFieldCapBytes,
} from "../trajectory-recorder";

let tmpDir: string;
const originalReviewMode = process.env.ELIZA_TRAJECTORY_REVIEW_MODE;
const originalMarkdownDir = process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR;
const originalCerebrasKey = process.env.CEREBRAS_API_KEY;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "trajectory-recorder-test-"),
	);
	delete process.env.ELIZA_TRAJECTORY_REVIEW_MODE;
	delete process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR;
	delete process.env.CEREBRAS_API_KEY;
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
	if (originalReviewMode === undefined) {
		delete process.env.ELIZA_TRAJECTORY_REVIEW_MODE;
	} else {
		process.env.ELIZA_TRAJECTORY_REVIEW_MODE = originalReviewMode;
	}
	if (originalMarkdownDir === undefined) {
		delete process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR;
	} else {
		process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR = originalMarkdownDir;
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

	it("tags every LLM step with priceTableId when cost is annotated", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-price-table",
			rootMessage: { id: "msg", text: "test" },
		});

		await recorder.recordStage(id, {
			stageId: "stage-anthropic",
			kind: "planner",
			startedAt: 0,
			endedAt: 100,
			latencyMs: 100,
			model: {
				modelType: "ACTION_PLANNER",
				modelName: "claude-opus-4-7",
				provider: "anthropic",
				prompt: "p",
				response: "r",
				usage: {
					promptTokens: 1000,
					completionTokens: 500,
					totalTokens: 1500,
				},
			},
		});
		await recorder.endTrajectory(id, "finished");

		const trajectory = await recorder.load(id);
		const model = trajectory?.stages[0]?.model;
		expect(typeof model?.priceTableId).toBe("string");
		expect((model?.priceTableId ?? "").length).toBeGreaterThan(0);
		// Anthropic Opus: 1000 input * $15/M + 500 output * $75/M = $0.0525
		expect(model?.costUsd).toBeCloseTo(0.0525, 6);
	});

	it("annotates cost=0 with no warning for local-provider steps", async () => {
		const warn = vi.fn();
		const recorder = createJsonFileTrajectoryRecorder({
			rootDir: tmpDir,
			logger: { warn },
		});
		const id = recorder.startTrajectory({
			agentId: "agent-local",
			rootMessage: { id: "msg", text: "test" },
		});

		await recorder.recordStage(id, {
			stageId: "stage-local",
			kind: "planner",
			startedAt: 0,
			endedAt: 100,
			latencyMs: 100,
			model: {
				modelType: "ACTION_PLANNER",
				modelName: "qwen-2.5-14b-q5_k_m",
				provider: "ollama",
				prompt: "p",
				response: "r",
				usage: {
					promptTokens: 5000,
					completionTokens: 1000,
					totalTokens: 6000,
				},
			},
		});
		await recorder.endTrajectory(id, "finished");

		const trajectory = await recorder.load(id);
		expect(trajectory?.stages[0]?.model?.costUsd).toBe(0);
		expect(trajectory?.metrics.totalCostUsd).toBe(0);
		// The pricing module must not warn for local providers — local cost
		// is a real zero, not a missing price.
		const pricingWarns = warn.mock.calls.filter(
			(call) => typeof call[1] === "string" && call[1].includes("[pricing]"),
		);
		expect(pricingWarns).toHaveLength(0);
	});

	it("annotates cost=0 and warns when a hosted-provider model has no price entry", async () => {
		const warn = vi.fn();
		const recorder = createJsonFileTrajectoryRecorder({
			rootDir: tmpDir,
			logger: { warn },
		});
		const id = recorder.startTrajectory({
			agentId: "agent-unknown-hosted",
			rootMessage: { id: "msg", text: "test" },
		});

		await recorder.recordStage(id, {
			stageId: "stage-unknown",
			kind: "planner",
			startedAt: 0,
			endedAt: 100,
			latencyMs: 100,
			model: {
				modelType: "ACTION_PLANNER",
				modelName: "fictional-model-that-does-not-exist",
				provider: "openai",
				prompt: "p",
				response: "r",
				usage: {
					promptTokens: 1000,
					completionTokens: 500,
					totalTokens: 1500,
				},
			},
		});
		await recorder.endTrajectory(id, "finished");

		const trajectory = await recorder.load(id);
		// cost_usd defaults to 0 — observability must never crash.
		expect(trajectory?.stages[0]?.model?.costUsd).toBe(0);
		// And the recorder logged a structured warning so the operator can
		// see that pricing was missing.
		const pricingWarns = warn.mock.calls.filter(
			(call) => typeof call[1] === "string" && call[1].includes("[pricing]"),
		);
		expect(pricingWarns.length).toBeGreaterThanOrEqual(1);
	});

	it("preserves a caller-provided costUsd and tags it with priceTableId", async () => {
		// Mirrors what evaluator.ts / planner-loop.ts already do: they compute
		// costUsd themselves and hand it to recordStage. The recorder must
		// not overwrite that number but should still tag the table id.
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-precomputed",
			rootMessage: { id: "msg", text: "test" },
		});

		await recorder.recordStage(id, {
			stageId: "stage-precomputed",
			kind: "planner",
			startedAt: 0,
			endedAt: 100,
			latencyMs: 100,
			model: {
				modelType: "ACTION_PLANNER",
				modelName: "claude-haiku-4-5",
				provider: "anthropic",
				prompt: "p",
				response: "r",
				usage: {
					promptTokens: 100,
					completionTokens: 50,
					totalTokens: 150,
				},
				costUsd: 0.4242, // intentionally arbitrary to detect any overwrite
			},
		});
		await recorder.endTrajectory(id, "finished");

		const trajectory = await recorder.load(id);
		expect(trajectory?.stages[0]?.model?.costUsd).toBe(0.4242);
		expect(typeof trajectory?.stages[0]?.model?.priceTableId).toBe("string");
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
		process.env.ELIZA_TRAJECTORY_REVIEW_MODE = "1";
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

describe("action exec input/output/error capture (M12)", () => {
	const originalCap = process.env.ELIZA_TRAJECTORY_FIELD_CAP_BYTES;

	afterEach(() => {
		if (originalCap === undefined) {
			delete process.env.ELIZA_TRAJECTORY_FIELD_CAP_BYTES;
		} else {
			process.env.ELIZA_TRAJECTORY_FIELD_CAP_BYTES = originalCap;
		}
	});

	it("defaults to a 64KB per-field cap when the env var is unset", () => {
		delete process.env.ELIZA_TRAJECTORY_FIELD_CAP_BYTES;
		expect(resolveTrajectoryFieldCapBytes()).toBe(64 * 1024);
	});

	it("respects ELIZA_TRAJECTORY_FIELD_CAP_BYTES when set to a sane value", () => {
		process.env.ELIZA_TRAJECTORY_FIELD_CAP_BYTES = "8192";
		expect(resolveTrajectoryFieldCapBytes()).toBe(8192);
	});

	it("ignores invalid or sub-1KB caps and falls back to the default", () => {
		process.env.ELIZA_TRAJECTORY_FIELD_CAP_BYTES = "abc";
		expect(resolveTrajectoryFieldCapBytes()).toBe(64 * 1024);
		process.env.ELIZA_TRAJECTORY_FIELD_CAP_BYTES = "100";
		expect(resolveTrajectoryFieldCapBytes()).toBe(64 * 1024);
	});

	it("encodes objects to JSON and strings pass through unchanged", () => {
		expect(encodeTrajectoryFieldValue({ a: 1, b: "two" })).toBe(
			'{"a":1,"b":"two"}',
		);
		expect(encodeTrajectoryFieldValue("hello")).toBe("hello");
		expect(encodeTrajectoryFieldValue(undefined)).toBe("");
		expect(encodeTrajectoryFieldValue(null)).toBe("");
	});

	it("encodes Error instances via the sanitizer (no `{}` payloads)", () => {
		const encoded = encodeTrajectoryFieldValue(new Error("boom"));
		expect(encoded).toContain("boom");
		expect(encoded).toContain('"message"');
	});

	it("returns the original value when under the cap with no marker", () => {
		const { value, marker } = applyTrajectoryFieldCap("input", "small", 1024);
		expect(value).toBe("small");
		expect(marker).toBeNull();
	});

	it("truncates oversize values and emits a structured marker", () => {
		const big = "a".repeat(2048);
		const { value, marker } = applyTrajectoryFieldCap("output", big, 256);
		expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(256);
		expect(value.endsWith("...[truncated]")).toBe(true);
		expect(marker).toEqual({
			field: "output",
			originalBytes: 2048,
			capBytes: 256,
		});
	});

	it("captureToolStageIO encodes + caps input/output/error and omits unset fields", () => {
		const captured = captureToolStageIO({
			input: { q: "weather in Brooklyn" },
			output: { success: true, data: { temp: 72 } },
		});
		expect(captured.input).toBe('{"q":"weather in Brooklyn"}');
		expect(captured.output).toBe('{"success":true,"data":{"temp":72}}');
		expect(captured.errorText).toBeUndefined();
		expect(captured.truncated).toBeUndefined();
	});

	it("captureToolStageIO attaches a truncated[] marker only for capped fields", () => {
		const huge = "z".repeat(200_000);
		const captured = captureToolStageIO({
			input: { q: "small" },
			output: huge,
			error: "oops",
			capBytes: 1024,
		});
		expect(captured.input).toBe('{"q":"small"}');
		expect(captured.output?.endsWith("...[truncated]")).toBe(true);
		expect(captured.errorText).toBe("oops");
		expect(captured.truncated).toEqual([
			{ field: "output", originalBytes: 200_000, capBytes: 1024 },
		]);
	});

	it("captureToolStageIO captures all three when all three exceed the cap", () => {
		const big = "x".repeat(200_000);
		const captured = captureToolStageIO({
			input: big,
			output: big,
			error: big,
			capBytes: 2048,
		});
		expect(captured.truncated).toHaveLength(3);
		expect(captured.truncated?.map((t) => t.field).sort()).toEqual([
			"error",
			"input",
			"output",
		]);
		for (const marker of captured.truncated ?? []) {
			expect(marker.originalBytes).toBe(200_000);
			expect(marker.capBytes).toBe(2048);
		}
	});
});

describe("skill invocation capture (W1-T5 / M13)", () => {
	it("encodes args + result and omits unset fields", () => {
		const captured = captureSkillInvocationIO({
			args: { mode: "guidance", slug: "weather" },
			result: { instructions: "use the api", estimatedTokens: 12 },
		});
		expect(captured.args).toBe('{"mode":"guidance","slug":"weather"}');
		expect(captured.result).toBe(
			'{"instructions":"use the api","estimatedTokens":12}',
		);
		expect(captured.truncated).toBeUndefined();
	});

	it("respects an explicit capBytes and attaches per-field markers", () => {
		const big = "z".repeat(200_000);
		const captured = captureSkillInvocationIO({
			args: { mode: "script" },
			result: big,
			capBytes: 2048,
		});
		expect(captured.args).toBe('{"mode":"script"}');
		expect(captured.result?.endsWith("...[truncated]")).toBe(true);
		expect(
			Buffer.byteLength(captured.result ?? "", "utf8"),
		).toBeLessThanOrEqual(2048);
		expect(captured.truncated).toEqual([
			{ field: "result", originalBytes: 200_000, capBytes: 2048 },
		]);
	});

	it("defaults to the 64KB shared cap when capBytes is omitted", () => {
		const big = "y".repeat(100_000);
		const captured = captureSkillInvocationIO({
			args: { q: "small" },
			result: big,
		});
		expect(
			Buffer.byteLength(captured.result ?? "", "utf8"),
		).toBeLessThanOrEqual(64 * 1024);
		expect(captured.truncated?.[0]).toMatchObject({
			field: "result",
			capBytes: 64 * 1024,
		});
	});

	it("omits args/result when input fields are undefined", () => {
		const captured = captureSkillInvocationIO({});
		expect(captured.args).toBeUndefined();
		expect(captured.result).toBeUndefined();
		expect(captured.truncated).toBeUndefined();
	});
});

describe("integration: action stage records input/output/error (M12)", () => {
	let intTmpDir: string;

	beforeEach(async () => {
		intTmpDir = await fs.mkdtemp(
			path.join(os.tmpdir(), "trajectory-action-io-"),
		);
	});

	afterEach(async () => {
		await fs.rm(intTmpDir, { recursive: true, force: true });
	});

	it("persists captured action input/output on the tool stage", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: intTmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-action-io",
			rootMessage: { id: "msg", text: "run an action" },
		});

		const captured = captureToolStageIO({
			input: { q: "eliza", k: 3 },
			output: { success: true, data: { hits: [{ title: "first" }] } },
		});

		const stage: RecordedStage = {
			stageId: "stage-tool-WEB_SEARCH-1",
			kind: "tool",
			startedAt: 1,
			endedAt: 50,
			latencyMs: 49,
			tool: {
				name: "WEB_SEARCH",
				args: { q: "eliza", k: 3 },
				result: { success: true, data: { hits: [{ title: "first" }] } },
				success: true,
				durationMs: 49,
				input: captured.input,
				output: captured.output,
				errorText: captured.errorText,
				truncated: captured.truncated,
			},
		};
		await recorder.recordStage(id, stage);
		await recorder.endTrajectory(id, "finished");

		const loaded = await recorder.load(id);
		expect(loaded).not.toBeNull();
		const tool = loaded?.stages[0]?.tool;
		expect(tool?.input).toBe('{"q":"eliza","k":3}');
		expect(tool?.output).toBe(
			'{"success":true,"data":{"hits":[{"title":"first"}]}}',
		);
		expect(tool?.errorText).toBeUndefined();
		expect(tool?.truncated).toBeUndefined();
	});

	it("persists structured truncation markers when output exceeds the cap", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: intTmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-action-trunc",
			rootMessage: { id: "msg", text: "huge action output" },
		});

		const huge = "p".repeat(150_000);
		const captured = captureToolStageIO({
			input: { q: "small" },
			output: huge,
			error: undefined,
			capBytes: 4096,
		});

		await recorder.recordStage(id, {
			stageId: "stage-tool-BIG-1",
			kind: "tool",
			startedAt: 1,
			endedAt: 10,
			latencyMs: 9,
			tool: {
				name: "BIG_OUTPUT",
				args: { q: "small" },
				result: { success: true },
				success: true,
				durationMs: 9,
				input: captured.input,
				output: captured.output,
				errorText: captured.errorText,
				truncated: captured.truncated,
			},
		});
		await recorder.endTrajectory(id, "finished");

		const loaded = await recorder.load(id);
		const tool = loaded?.stages[0]?.tool;
		expect(tool?.output?.endsWith("...[truncated]")).toBe(true);
		expect(Buffer.byteLength(tool?.output ?? "", "utf8")).toBeLessThanOrEqual(
			4096,
		);
		expect(tool?.truncated).toEqual([
			{ field: "output", originalBytes: 150_000, capBytes: 4096 },
		]);
	});

	it("persists captured action error when the action fails", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: intTmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-action-err",
			rootMessage: { id: "msg", text: "failing action" },
		});

		const captured = captureToolStageIO({
			input: { q: "missing-config" },
			output: { success: false },
			error: new Error("Connection refused"),
		});

		await recorder.recordStage(id, {
			stageId: "stage-tool-BROKEN-1",
			kind: "tool",
			startedAt: 1,
			endedAt: 5,
			latencyMs: 4,
			tool: {
				name: "BROKEN",
				args: { q: "missing-config" },
				result: { success: false, error: new Error("Connection refused") },
				success: false,
				durationMs: 4,
				input: captured.input,
				output: captured.output,
				errorText: captured.errorText,
				truncated: captured.truncated,
			},
		});
		await recorder.endTrajectory(id, "finished");

		const loaded = await recorder.load(id);
		const tool = loaded?.stages[0]?.tool;
		expect(tool?.success).toBe(false);
		expect(tool?.errorText).toContain("Connection refused");
		expect(tool?.input).toBe('{"q":"missing-config"}');
	});
});
