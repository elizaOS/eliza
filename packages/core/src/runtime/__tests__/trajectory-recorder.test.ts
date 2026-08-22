/**
 * Unit tests for the JSON-file trajectory recorder: stage recording, metrics
 * roll-up, field capping/sanitization, price-table cost annotation, redacted
 * markdown review artifacts, and finalize leak-guarding. Runs against real
 * temp-dir filesystem writes with an in-process recorder — no live model;
 * token/usage and cost inputs are hand-fed.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The real canonical parser, imported by path on purpose: the round-trip test
// must fail if the recorder's terminal shape and the validator's accepted
// vocabulary ever drift apart.
import { validateTrajectory } from "../../../../scripts/lib/trajectory-validate";
import { TRACE_ENV } from "../trace-correlation";
import {
	captureSkillInvocationIO,
	captureToolStageIO,
	createJsonFileTrajectoryRecorder,
	encodeTrajectoryFieldValue,
	finalizeTrajectoryRecording,
	type RecordedStage,
	type RecordedTrajectory,
} from "../trajectory-recorder";

let tmpDir: string;
const originalReviewMode = process.env.ELIZA_TRAJECTORY_REVIEW_MODE;
const originalMarkdownDir = process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR;
const originalCerebrasKey = process.env.CEREBRAS_API_KEY;
const originalTrajectoryLogging = process.env.ELIZA_TRAJECTORY_LOGGING;
const originalDisableTrajectoryLogging =
	process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "trajectory-recorder-test-"),
	);
	delete process.env.ELIZA_TRAJECTORY_REVIEW_MODE;
	delete process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR;
	delete process.env.CEREBRAS_API_KEY;
	delete process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
	// The unified gate (#13775) defaults recording OFF under NODE_ENV=test,
	// which vitest sets; this suite exercises real file writes, so it opts in
	// explicitly. The gate's default-off policy stays covered by
	// trajectory-gate.test.ts and the gate-default test below.
	process.env.ELIZA_TRAJECTORY_LOGGING = "1";
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
	if (originalTrajectoryLogging === undefined) {
		delete process.env.ELIZA_TRAJECTORY_LOGGING;
	} else {
		process.env.ELIZA_TRAJECTORY_LOGGING = originalTrajectoryLogging;
	}
	if (originalDisableTrajectoryLogging === undefined) {
		delete process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
	} else {
		process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING =
			originalDisableTrajectoryLogging;
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
					reasoningTokens: 400,
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
		// #16394: reasoning tokens roll up across stages; only the
		// message-handler stage carried them here (400), the others omit the
		// field and contribute 0.
		expect(parsed.metrics.totalReasoningTokens).toBe(400);
		expect(parsed.stages[0]?.model?.usage?.reasoningTokens).toBe(400);
		expect(parsed.stages[1]?.model?.usage?.reasoningTokens).toBeUndefined();
		expect(parsed.metrics.finalDecision).toBe("FINISH");
		expect(parsed.metrics.totalLatencyMs).toBe(300 + 600 + 110 + 270);
	});

	it("recordStage stores bounded JSON-safe copies of rich stage payloads", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-test",
			rootMessage: { id: "msg-1", text: "hello" },
		});
		const circular: Record<string, unknown> = {
			long: "x".repeat(120_000),
			values: Array.from({ length: 400 }, (_, index) => index),
			buffer: new Uint8Array(1024),
		};
		circular.self = circular;

		await recorder.recordStage(id, {
			stageId: "stage-sanitize",
			kind: "messageHandler",
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
			model: {
				modelType: "RESPONSE_HANDLER",
				provider: "test",
				messages: [
					{
						role: "user",
						content: "m".repeat(120_000),
						meta: circular,
					},
				],
				tools: Array.from({ length: 400 }, (_, index) => ({
					name: `tool-${index}`,
				})),
				providerOptions: circular,
				response: "ok",
			},
		} as RecordedStage);

		const reloaded = await recorder.load(id);
		const stage = reloaded?.stages[0] as
			| (RecordedStage & { model?: Record<string, unknown> })
			| undefined;
		const model = stage?.model as
			| {
					messages?: Array<{
						content?: string;
						meta?: Record<string, unknown>;
					}>;
					tools?: unknown[];
					providerOptions?: Record<string, unknown>;
			  }
			| undefined;

		expect(model?.messages?.[0]?.content).toBe("m".repeat(120_000));
		expect(model?.messages?.[0]?.meta?.self).toBe("[Circular]");
		expect(model?.providerOptions?.self).toBe("[Circular]");
		expect(model?.tools).toHaveLength(400);
		expect(model?.providerOptions?.long).toBe("x".repeat(120_000));
	});

	it("startTrajectory stores a complete copy of the root message", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const rootMessage = {
			id: "msg-root",
			text: "r".repeat(120_000),
			sender: "user-1",
		};
		const id = recorder.startTrajectory({
			agentId: "agent-test",
			rootMessage,
		});
		rootMessage.text = "mutated after start";

		await recorder.endTrajectory(id, "finished");

		const reloaded = await recorder.load(id);
		expect(reloaded?.rootMessage.id).toBe("msg-root");
		expect(reloaded?.rootMessage.text).not.toBe("mutated after start");
		expect(reloaded?.rootMessage.text).toBe("r".repeat(120_000));
		expect(reloaded?.rootMessage.sender).toBe("user-1");
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

	it("round-trips empty-object tool args + empty schema properties as {} not '[object Object]'", async () => {
		// Live regression (dog-site session, 2026-05-28): a recorded
		// HANDLE_RESPONSE tool call surfaced as args="[object Object]" because
		// sanitizeForRecord did String(value) on an empty object. That corrupts
		// any trajectory analysis / eval / training that reads
		// stages[].model.toolCalls[].args or model.tools[].parameters.properties.
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-empty-args",
			rootMessage: { id: "msg-empty-args", text: "status?" },
		});
		await recorder.recordStage(id, {
			stageId: "stage-planner-empty-args",
			kind: "planner",
			iteration: 1,
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
			model: {
				modelType: "ACTION_PLANNER",
				modelName: "gpt-oss-120b",
				provider: "cerebras",
				prompt: "p",
				response: "",
				toolCalls: [{ id: "c1", name: "NO_PARAM_TOOL", args: {} }],
				tools: [
					{
						name: "NO_PARAM_TOOL",
						description: "no params",
						parameters: { type: "object", properties: {} },
					},
				],
				toolChoice: "auto",
			},
		});
		await recorder.endTrajectory(id, "finished");

		const trajectory = await recorder.load(id);
		const planner = trajectory?.stages.find((s) => s.kind === "planner");
		const args = planner?.model?.toolCalls?.[0]?.args;
		expect(args).toEqual({});
		expect(args).not.toBe("[object Object]");
		const props = planner?.model?.tools?.[0]?.parameters?.properties;
		expect(props).toEqual({});
		expect(props).not.toBe("[object Object]");
	});

	it("keeps URL-like empty-entry objects on the string fallback path", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-url-arg",
			rootMessage: { id: "msg-url-arg", text: "inspect url" },
		});
		await recorder.recordStage(id, {
			stageId: "stage-url-arg",
			kind: "planner",
			iteration: 1,
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
			model: {
				modelType: "ACTION_PLANNER",
				modelName: "gpt-oss-120b",
				provider: "cerebras",
				prompt: "p",
				response: "",
				toolCalls: [
					{
						id: "c1",
						name: "FETCH_URL",
						args: new URL("https://example.com/a?b=1"),
					},
				],
			},
		});
		await recorder.endTrajectory(id, "finished");

		const trajectory = await recorder.load(id);
		const planner = trajectory?.stages.find((s) => s.kind === "planner");
		expect(planner?.model?.toolCalls?.[0]?.args).toBe(
			"https://example.com/a?b=1",
		);
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
		// 1M in @ $0.35 + 1M out @ $0.75 — the canonical Cerebras rates in
		// features/trajectories/pricing.ts (aligned 2026-08-14; this expectation
		// was missed when the table moved off the old 1.30 total).
		expect(trajectory?.stages[0]?.model?.costUsd).toBeCloseTo(1.1, 6);
		expect(trajectory?.metrics.totalCostUsd).toBeCloseTo(1.1, 6);
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
		// Anthropic Opus: 1000 input * $5/M + 500 output * $25/M = $0.0175
		expect(model?.costUsd).toBeCloseTo(0.0175, 6);
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
				modelName: "eliza-1-4b-q4_k_m",
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
		// Unknown hosted pricing is omitted rather than recorded as free inference.
		expect(trajectory?.stages[0]?.model?.costUsd).toBeUndefined();
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

	it("stamps the canonical clean terminal on a finished trajectory with no evaluation stage", async () => {
		// Non-evaluated terminal paths (Stage-1 direct reply, deterministic
		// fallback, structured failure reply) end a turn without any evaluation
		// stage. The recorder must still stamp the clean terminal — an absent
		// finalDecision on a finished trajectory previously read as "died after
		// planner" and made delivered turns indistinguishable from drops. The
		// stamp must be a member of the canonical validator's closed
		// finalDecision vocabulary, not an invented sentinel.
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-direct-reply",
			rootMessage: { id: "msg", text: "whats my favorite color?" },
		});
		await recorder.recordStage(id, {
			stageId: "stage-msghandler-1",
			kind: "messageHandler",
			startedAt: 1_000,
			endedAt: 1_200,
			latencyMs: 200,
			model: {
				modelType: "RESPONSE_HANDLER",
				provider: "test",
				response: "crimson.",
			},
		});
		await recorder.endTrajectory(id, "finished");
		const trajectory = await recorder.load(id);
		expect(trajectory?.status).toBe("finished");
		expect(trajectory?.metrics.finalDecision).toBe("FINISH");
	});

	it("round-trips the stamped clean terminal through the real canonical validator", async () => {
		// The canonical parser (packages/scripts/lib/trajectory-validate.ts)
		// accepts only FINISH / CONTINUE / max_iterations / error for
		// finalDecision — any invented terminal sentinel fails validation for
		// every recorded trajectory. This drives the REAL validator, not a
		// re-declared vocabulary, so recorder and parser cannot drift apart.
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-validator-roundtrip",
			rootMessage: { id: "msg", text: "whats my favorite color?" },
		});
		await recorder.recordStage(id, {
			stageId: "stage-msghandler-1",
			kind: "messageHandler",
			startedAt: 1_000,
			endedAt: 1_200,
			latencyMs: 200,
			model: {
				modelType: "RESPONSE_HANDLER",
				provider: "test",
				response: "crimson.",
			},
		});
		await recorder.endTrajectory(id, "finished");
		const trajectory = await recorder.load(id);
		const result = validateTrajectory(trajectory);
		const finalDecisionIssues = result.issues.filter(
			(issue) => issue.path === "$.metrics.finalDecision",
		);
		expect(finalDecisionIssues).toEqual([]);
	});

	it("does not overwrite an evaluation-derived finalDecision at finish", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-eval-continue",
			rootMessage: { id: "msg", text: "x" },
		});
		await recorder.recordStage(id, {
			stageId: "stage-eval-iter-1",
			kind: "evaluation",
			iteration: 1,
			startedAt: 1_000,
			endedAt: 1_100,
			latencyMs: 100,
			evaluation: { success: true, decision: "CONTINUE", thought: "more" },
		});
		await recorder.endTrajectory(id, "finished");
		const trajectory = await recorder.load(id);
		expect(trajectory?.metrics.finalDecision).toBe("CONTINUE");
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

	it("surfaces corrupt trajectory artifacts instead of treating them as absent", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const agentDir = path.join(tmpDir, "agent-corrupt");
		await fs.mkdir(agentDir, { recursive: true });
		await fs.writeFile(
			path.join(agentDir, "bad-record.json"),
			"{broken",
			"utf8",
		);

		await expect(recorder.load("bad-record")).rejects.toMatchObject({
			code: "TRAJECTORY_LOAD_FAILED",
		});
		await expect(recorder.list()).rejects.toMatchObject({
			code: "TRAJECTORY_LIST_ENTRY_FAILED",
		});
	});

	it("persists runId/scenarioId passed at the call site (message.ts wiring)", async () => {
		// message.ts reads ELIZA_LIFEOPS_RUN_ID/SCENARIO_ID and passes them into
		// startTrajectory; the recorder must round-trip them onto the file so the
		// lifeops aggregator can group a scenario run by its join keys.
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-run",
			rootMessage: { id: "m", text: "hi" },
			runId: "run-abc",
			scenarioId: "scenario-xyz",
		});
		await recorder.endTrajectory(id, "finished");

		const filePath = path.join(tmpDir, "agent-run", `${id}.json`);
		const parsed = JSON.parse(
			await fs.readFile(filePath, "utf8"),
		) as RecordedTrajectory;
		expect(parsed.runId).toBe("run-abc");
		expect(parsed.scenarioId).toBe("scenario-xyz");
	});

	it("inherits the spawned orchestrator session id for trajectory correlation", async () => {
		const previous = process.env[TRACE_ENV.SESSION_ID];
		process.env[TRACE_ENV.SESSION_ID] = "session-from-spawn";
		try {
			const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
			const id = recorder.startTrajectory({
				agentId: "agent-session",
				rootMessage: { id: "m", text: "hi" },
			});
			await recorder.endTrajectory(id, "finished");

			const parsed = JSON.parse(
				await fs.readFile(
					path.join(tmpDir, "agent-session", `${id}.json`),
					"utf8",
				),
			) as RecordedTrajectory;
			expect(parsed.sessionId).toBe("session-from-spawn");
		} finally {
			if (previous === undefined) delete process.env[TRACE_ENV.SESSION_ID];
			else process.env[TRACE_ENV.SESSION_ID] = previous;
		}
	});

	it("falls back to ELIZA_LIFEOPS_* env when runId/scenarioId omitted", async () => {
		const priorRun = process.env.ELIZA_LIFEOPS_RUN_ID;
		const priorScenario = process.env.ELIZA_LIFEOPS_SCENARIO_ID;
		process.env.ELIZA_LIFEOPS_RUN_ID = "env-run";
		process.env.ELIZA_LIFEOPS_SCENARIO_ID = "env-scenario";
		try {
			const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
			const id = recorder.startTrajectory({
				agentId: "agent-envrun",
				rootMessage: { id: "m", text: "hi" },
			});
			await recorder.endTrajectory(id, "finished");
			const parsed = JSON.parse(
				await fs.readFile(
					path.join(tmpDir, "agent-envrun", `${id}.json`),
					"utf8",
				),
			) as RecordedTrajectory;
			expect(parsed.runId).toBe("env-run");
			expect(parsed.scenarioId).toBe("env-scenario");
		} finally {
			if (priorRun === undefined) delete process.env.ELIZA_LIFEOPS_RUN_ID;
			else process.env.ELIZA_LIFEOPS_RUN_ID = priorRun;
			if (priorScenario === undefined)
				delete process.env.ELIZA_LIFEOPS_SCENARIO_ID;
			else process.env.ELIZA_LIFEOPS_SCENARIO_ID = priorScenario;
		}
	});

	it("treats blank ELIZA_LIFEOPS_* env values as unset", async () => {
		const priorRun = process.env.ELIZA_LIFEOPS_RUN_ID;
		const priorScenario = process.env.ELIZA_LIFEOPS_SCENARIO_ID;
		process.env.ELIZA_LIFEOPS_RUN_ID = "";
		process.env.ELIZA_LIFEOPS_SCENARIO_ID = "   ";
		try {
			const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
			const id = recorder.startTrajectory({
				agentId: "agent-blank-env",
				rootMessage: { id: "m", text: "hi" },
			});
			await recorder.endTrajectory(id, "finished");
			const parsed = JSON.parse(
				await fs.readFile(
					path.join(tmpDir, "agent-blank-env", `${id}.json`),
					"utf8",
				),
			) as RecordedTrajectory;
			expect(parsed.runId).toBeUndefined();
			expect(parsed.scenarioId).toBeUndefined();
		} finally {
			if (priorRun === undefined) delete process.env.ELIZA_LIFEOPS_RUN_ID;
			else process.env.ELIZA_LIFEOPS_RUN_ID = priorRun;
			if (priorScenario === undefined)
				delete process.env.ELIZA_LIFEOPS_SCENARIO_ID;
			else process.env.ELIZA_LIFEOPS_SCENARIO_ID = priorScenario;
		}
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

	it("defaults to disabled under NODE_ENV=test when no trajectory knob is set (#13775 gate)", async () => {
		delete process.env.ELIZA_TRAJECTORY_LOGGING;
		const priorLegacyRecording = process.env.ELIZA_TRAJECTORY_RECORDING;
		delete process.env.ELIZA_TRAJECTORY_RECORDING;
		const priorDisableLogging = process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
		delete process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
		const priorNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "test";
		try {
			const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
			const id = recorder.startTrajectory({
				agentId: "gate-default",
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

			// The suite-level ELIZA_TRAJECTORY_LOGGING opt-in is load-bearing:
			// a bare recorder under the test default stays dark and writes nothing.
			const entries = await fs.readdir(tmpDir).catch(() => [] as string[]);
			expect(entries).toEqual([]);
		} finally {
			if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
			else process.env.NODE_ENV = priorNodeEnv;
			if (priorLegacyRecording === undefined)
				delete process.env.ELIZA_TRAJECTORY_RECORDING;
			else process.env.ELIZA_TRAJECTORY_RECORDING = priorLegacyRecording;
			if (priorDisableLogging === undefined)
				delete process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
			else process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING = priorDisableLogging;
		}
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

	it("output JSON is structurally compatible with the packages/scripts trajectory tooling schema", async () => {
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
	it("encodes objects to JSON and strings pass through unchanged", () => {
		expect(encodeTrajectoryFieldValue({ a: 1, b: "two" })).toBe(
			'{"a":1,"b":"two"}',
		);
		expect(encodeTrajectoryFieldValue({})).toBe("{}");
		const nullPrototype = Object.create(null);
		expect(encodeTrajectoryFieldValue(nullPrototype)).toBe("{}");
		expect(encodeTrajectoryFieldValue(new URL("https://example.com/a"))).toBe(
			'"https://example.com/a"',
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

	it("captureToolStageIO encodes input/output/error and omits unset fields", () => {
		const captured = captureToolStageIO({
			input: { q: "weather in Brooklyn" },
			output: { success: true, data: { temp: 72 } },
		});
		expect(captured.input).toBe('{"q":"weather in Brooklyn"}');
		expect(captured.output).toBe('{"success":true,"data":{"temp":72}}');
		expect(captured.errorText).toBeUndefined();
	});

	it("captureToolStageIO preserves empty plain records as JSON objects", () => {
		const captured = captureToolStageIO({
			input: {},
			output: { args: {} },
		});
		expect(captured.input).toBe("{}");
		expect(captured.output).toBe('{"args":{}}');
	});

	it("captureToolStageIO preserves every field regardless of legacy cap", () => {
		const huge = "z".repeat(200_000);
		const captured = captureToolStageIO({
			input: { q: "small" },
			output: huge,
			error: "oops",
		});
		expect(captured.input).toBe('{"q":"small"}');
		expect(captured.output).toBe(huge);
		expect(captured.errorText).toBe("oops");
	});

	it("captureToolStageIO preserves all three fields", () => {
		const big = "x".repeat(200_000);
		const captured = captureToolStageIO({
			input: big,
			output: big,
			error: big,
		});
		expect(captured.input).toBe(big);
		expect(captured.output).toBe(big);
		expect(captured.errorText).toBe(big);
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
	});

	it("preserves complete skill results", () => {
		const big = "z".repeat(200_000);
		const captured = captureSkillInvocationIO({
			args: { mode: "script" },
			result: big,
		});
		expect(captured.args).toBe('{"mode":"script"}');
		expect(captured.result).toBe(big);
	});

	it("preserves complete results when capBytes is omitted", () => {
		const big = "y".repeat(100_000);
		const captured = captureSkillInvocationIO({
			args: { q: "small" },
			result: big,
		});
		expect(captured.result).toBe(big);
	});

	it("omits args/result when input fields are undefined", () => {
		const captured = captureSkillInvocationIO({});
		expect(captured.args).toBeUndefined();
		expect(captured.result).toBeUndefined();
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

	it("persists complete output when it exceeds a legacy cap", async () => {
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
			},
		});
		await recorder.endTrajectory(id, "finished");

		const loaded = await recorder.load(id);
		const tool = loaded?.stages[0]?.tool;
		expect(tool?.output).toBe(huge);
		expect(tool?.truncated).toBeUndefined();
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
			},
		});
		await recorder.endTrajectory(id, "finished");

		const loaded = await recorder.load(id);
		const tool = loaded?.stages[0]?.tool;
		expect(tool?.success).toBe(false);
		expect(tool?.errorText).toContain("Connection refused");
		expect(tool?.input).toBe('{"q":"missing-config"}');
	});

	it("captures the executed action's model-facing description (incl. routing hint) on the tool stage and renders it in the markdown review", async () => {
		process.env.ELIZA_TRAJECTORY_REVIEW_MODE = "1";
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-docs",
			rootMessage: { id: "m-docs", text: "remind me at 9pm" },
		});

		// The exposed ToolDefinition description = routingHint + "\n" + compressed
		// description (what the planner actually saw for this action).
		const modelFacingDescription =
			"manage EXISTING scheduled items -> SCHEDULED_TASKS; coding work -> TASKS\nmanage owner scheduled items";
		const toolStage: RecordedStage = {
			stageId: "stage-tool-SCHEDULED_TASKS",
			kind: "tool",
			startedAt: 100,
			endedAt: 210,
			latencyMs: 110,
			tool: {
				name: "SCHEDULED_TASKS",
				args: { action: "create" },
				result: { ok: true },
				success: true,
				durationMs: 110,
				description: modelFacingDescription,
			},
		};
		await recorder.recordStage(id, toolStage);
		await recorder.endTrajectory(id, "finished");

		// JSON round-trip: the execution record is self-contained.
		const loaded = await recorder.load(id);
		const tool = loaded?.stages[0]?.tool;
		expect(tool?.description).toBe(modelFacingDescription);

		// Markdown review surfaces the when-to-use guidance on the executed action
		// without cross-referencing the planner stage's model.tools.
		const markdownPath = path.join(tmpDir, "agent-docs", `${id}.md`);
		const markdown = await fs.readFile(markdownPath, "utf8");
		expect(markdown).toContain(
			"- description: manage EXISTING scheduled items -> SCHEDULED_TASKS",
		);
	});
});

describe("finalizeTrajectoryRecording (running-status leak guard)", () => {
	const rootMessage = { id: "msg-1", text: "hello", sender: "user-1" };

	async function readPersisted(id: string): Promise<RecordedTrajectory> {
		const raw = await fs.readFile(
			path.join(tmpDir, "agent-test", `${id}.json`),
			"utf8",
		);
		return JSON.parse(raw) as RecordedTrajectory;
	}

	it("writes terminal status independently of a never-settling background task", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({ agentId: "agent-test", rootMessage });
		const neverSettles = new Promise<void>(() => undefined);
		void neverSettles;

		await finalizeTrajectoryRecording({
			recorder,
			trajectoryId: id,
			status: "finished",
		});

		expect((await readPersisted(id)).status).toBe("finished");
	});

	it("writes the requested errored status", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({ agentId: "agent-test", rootMessage });

		await finalizeTrajectoryRecording({
			recorder,
			trajectoryId: id,
			status: "errored",
		});

		const persisted = await readPersisted(id);
		expect(persisted.status).toBe("errored");
		expect(persisted.metrics.finalDecision).toBe("error");
	});

	it("preserves stages the caller records before entering the terminal boundary", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({ agentId: "agent-test", rootMessage });
		await recorder.recordStage(id, {
			stageId: "stage-facts-1",
			kind: "factsAndRelationships",
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
		});

		await finalizeTrajectoryRecording({
			recorder,
			trajectoryId: id,
			status: "finished",
		});

		const persisted = await readPersisted(id);
		expect(persisted.status).toBe("finished");
		expect(persisted.stages).toHaveLength(1);
		expect(persisted.stages[0]?.stageId).toBe("stage-facts-1");
	});

	it("never throws, even when endTrajectory itself rejects", async () => {
		const warn = vi.fn();
		const failing = {
			startTrajectory: () => "tj-x",
			recordStage: async () => undefined,
			endTrajectory: async () => {
				throw new Error("disk gone");
			},
			load: async () => null,
			list: async () => [],
		};

		await expect(
			finalizeTrajectoryRecording({
				recorder: failing,
				trajectoryId: "tj-x",
				status: "finished",
				logger: { warn },
			}),
		).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: "disk gone", trajectoryId: "tj-x" }),
			expect.stringContaining("endTrajectory failed"),
		);
	});

	it("ends immediately when there is no pre-end work", async () => {
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({ agentId: "agent-test", rootMessage });

		await finalizeTrajectoryRecording({
			recorder,
			trajectoryId: id,
			status: "finished",
		});

		expect((await readPersisted(id)).status).toBe("finished");
	});
});

// The scenario CLI sets ELIZA_LIFEOPS_RUN_ID / ELIZA_LIFEOPS_SCENARIO_ID before
// each run/scenario (cli.ts) and the message loop constructs this recorder
// without passing runId/scenarioId, so correlation flows entirely through the
// recorder's env fallback. These lock in that behavior and the empty-is-unset
// contract that keeps a blank env var from writing a garbage correlation key.
describe("run/scenario correlation via env", () => {
	const rootMessage = { id: "msg-1", text: "hello", sender: "user-1" };
	const originalRunId = process.env.ELIZA_LIFEOPS_RUN_ID;
	const originalScenarioId = process.env.ELIZA_LIFEOPS_SCENARIO_ID;

	afterEach(() => {
		if (originalRunId === undefined) delete process.env.ELIZA_LIFEOPS_RUN_ID;
		else process.env.ELIZA_LIFEOPS_RUN_ID = originalRunId;
		if (originalScenarioId === undefined)
			delete process.env.ELIZA_LIFEOPS_SCENARIO_ID;
		else process.env.ELIZA_LIFEOPS_SCENARIO_ID = originalScenarioId;
	});

	async function readPersisted(id: string): Promise<RecordedTrajectory> {
		const raw = await fs.readFile(
			path.join(tmpDir, "agent-test", `${id}.json`),
			"utf8",
		);
		return JSON.parse(raw) as RecordedTrajectory;
	}

	it("tags the trajectory with the run/scenario env even when the call site omits them", async () => {
		process.env.ELIZA_LIFEOPS_RUN_ID = "run-xyz";
		process.env.ELIZA_LIFEOPS_SCENARIO_ID = "scenario-abc";
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({ agentId: "agent-test", rootMessage });
		await recorder.endTrajectory(id, "finished");

		const persisted = await readPersisted(id);
		expect(persisted.runId).toBe("run-xyz");
		expect(persisted.scenarioId).toBe("scenario-abc");
	});

	it("leaves run/scenario unset when the env is unset", async () => {
		delete process.env.ELIZA_LIFEOPS_RUN_ID;
		delete process.env.ELIZA_LIFEOPS_SCENARIO_ID;
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({ agentId: "agent-test", rootMessage });
		await recorder.endTrajectory(id, "finished");

		const persisted = await readPersisted(id);
		expect(persisted.runId).toBeUndefined();
		expect(persisted.scenarioId).toBeUndefined();
	});

	it("treats a blank/whitespace env value as unset (no empty-string correlation key)", async () => {
		process.env.ELIZA_LIFEOPS_RUN_ID = "";
		process.env.ELIZA_LIFEOPS_SCENARIO_ID = "   ";
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({ agentId: "agent-test", rootMessage });
		await recorder.endTrajectory(id, "finished");

		const persisted = await readPersisted(id);
		expect(persisted.runId).toBeUndefined();
		expect(persisted.scenarioId).toBeUndefined();
	});

	it("prefers an explicit call-site value over the env fallback", async () => {
		process.env.ELIZA_LIFEOPS_RUN_ID = "run-from-env";
		const recorder = createJsonFileTrajectoryRecorder({ rootDir: tmpDir });
		const id = recorder.startTrajectory({
			agentId: "agent-test",
			rootMessage,
			runId: "run-explicit",
		});
		await recorder.endTrajectory(id, "finished");

		expect((await readPersisted(id)).runId).toBe("run-explicit");
	});
});
