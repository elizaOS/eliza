/**
 * Branch-coverage tests for the trajectory recorder's public helpers and the
 * JsonFileTrajectoryRecorder paths the main suite does not exercise:
 * directory-resolution precedence, the markdown-review flag matrix,
 * unknown-trajectory-id handling, load/list filesystem edges, the noop
 * recorder, final-persistence diagnostic projection, and the trajectory field
 * encoder's type matrix. Real temp-dir filesystem, deterministic inputs, no
 * live model.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../../utils/state-dir";
import {
	createJsonFileTrajectoryRecorder,
	encodeTrajectoryFieldValue,
	getNoopTrajectoryRecorder,
	isTrajectoryMarkdownReviewEnabled,
	projectRecordedStageToolDiagnostics,
	type RecordedStage,
	type RecordedTrajectory,
	resolveTrajectoryDir,
} from "../trajectory-recorder";

let tmpDir: string;

const ENV_KEYS = [
	"ELIZA_TRAJECTORY_DIR",
	"ELIZA_STATE_DIR",
	"ELIZA_TRAJECTORY_REVIEW_MODE",
	"ELIZA_TRAJECTORY_MARKDOWN",
	"ELIZA_TRAJECTORY_MARKDOWN_DIR",
] as const;

const savedEnv = new Map<string, string | undefined>();

beforeEach(async () => {
	tmpDir = await fs.mkdtemp(
		path.join(os.tmpdir(), "trajectory-recorder-branches-"),
	);
	for (const key of ENV_KEYS) {
		savedEnv.set(key, process.env[key]);
		delete process.env[key];
	}
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
	for (const key of ENV_KEYS) {
		const value = savedEnv.get(key);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	savedEnv.clear();
});

function makeMinimalTrajectory(
	trajectoryId: string,
	agentId: string,
	startedAt: number,
): RecordedTrajectory {
	return {
		trajectoryId,
		agentId,
		rootMessage: { id: "root-1", text: "root text" },
		startedAt,
		status: "finished",
		stages: [],
		metrics: {
			totalLatencyMs: 1,
			totalPromptTokens: 0,
			totalCompletionTokens: 0,
			totalCacheReadTokens: 0,
			totalCacheCreationTokens: 0,
			totalReasoningTokens: 0,
			totalCostUsd: 0,
			plannerIterations: 0,
			toolCallsExecuted: 0,
			toolCallFailures: 0,
			toolSearchCount: 0,
			evaluatorFailures: 0,
		},
	};
}

async function writeTrajectoryFile(
	relationPath: string,
	trajectory: RecordedTrajectory,
): Promise<void> {
	const filePath = path.join(tmpDir, relationPath);
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, JSON.stringify(trajectory), "utf8");
}

describe("resolveTrajectoryDir precedence", () => {
	it("prefers an explicit ELIZA_TRAJECTORY_DIR and trims surrounding whitespace", () => {
		process.env.ELIZA_TRAJECTORY_DIR = `  ${path.join(tmpDir, "custom")}  `;
		expect(resolveTrajectoryDir()).toBe(path.join(tmpDir, "custom"));
	});

	it("falls back to ELIZA_STATE_DIR/trajectories when no explicit dir is set", () => {
		const stateDir = path.join(tmpDir, "state");
		process.env.ELIZA_STATE_DIR = stateDir;
		expect(resolveTrajectoryDir()).toBe(path.join(stateDir, "trajectories"));
	});

	it("delegates to the shared state-dir resolver when neither variable is set", () => {
		expect(resolveTrajectoryDir()).toBe(
			path.join(resolveStateDir(), "trajectories"),
		);
	});
});

describe("isTrajectoryMarkdownReviewEnabled flag matrix", () => {
	it("is off when every markdown-review knob is unset", () => {
		expect(isTrajectoryMarkdownReviewEnabled()).toBe(false);
	});

	it("treats 0/false/no/off as disabled regardless of which knob carries them", () => {
		for (const falsey of ["0", "false", "no", "off"]) {
			process.env.ELIZA_TRAJECTORY_REVIEW_MODE = falsey;
			process.env.ELIZA_TRAJECTORY_MARKDOWN = falsey;
			expect(isTrajectoryMarkdownReviewEnabled()).toBe(false);
		}
	});

	it("turns on from ELIZA_TRAJECTORY_REVIEW_MODE with any other non-empty value", () => {
		process.env.ELIZA_TRAJECTORY_REVIEW_MODE = "yes";
		expect(isTrajectoryMarkdownReviewEnabled()).toBe(true);
	});

	it("turns on from ELIZA_TRAJECTORY_MARKDOWN alone", () => {
		process.env.ELIZA_TRAJECTORY_MARKDOWN = "true";
		expect(isTrajectoryMarkdownReviewEnabled()).toBe(true);
	});

	it("turns on when only the markdown output directory is configured", () => {
		process.env.ELIZA_TRAJECTORY_REVIEW_MODE = "0";
		process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR = path.join(tmpDir, "md");
		expect(isTrajectoryMarkdownReviewEnabled()).toBe(true);
	});
});

describe("recording against unknown trajectory ids", () => {
	it("warns and resolves without writing anything for recordStage/endTrajectory on an unstarted id", async () => {
		const warn = vi.fn();
		const recorder = createJsonFileTrajectoryRecorder({
			rootDir: tmpDir,
			enabled: true,
			logger: { warn },
		});

		await recorder.recordStage("tj-missing", {
			stageId: "stage-orphan",
			kind: "planner",
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
		});
		await recorder.endTrajectory("tj-missing", "errored");

		expect(warn).toHaveBeenCalledTimes(2);
		const messages = warn.mock.calls.map((call) => String(call[1]));
		expect(messages[0]).toContain("recordStage: trajectory not found");
		expect(messages[1]).toContain("endTrajectory: trajectory not found");
		expect(await fs.readdir(tmpDir)).toEqual([]);
	});
});

describe("load/list filesystem edges", () => {
	it("returns null for a load of an id that was never persisted", async () => {
		const recorder = createJsonFileTrajectoryRecorder({
			rootDir: tmpDir,
			enabled: true,
		});
		await expect(recorder.load("tj-absent")).resolves.toBeNull();
	});

	it("returns an empty list when the storage root does not exist yet", async () => {
		const recorder = createJsonFileTrajectoryRecorder({
			rootDir: path.join(tmpDir, "does-not-exist"),
			enabled: true,
		});
		await expect(recorder.list()).resolves.toEqual([]);
	});

	it("collects nested agent directories but ignores non-JSON files and temp files", async () => {
		await writeTrajectoryFile(
			path.join("agent-a", "tj-old.json"),
			makeMinimalTrajectory("tj-old", "agent-a", 100),
		);
		await writeTrajectoryFile(
			path.join("nested", "agent-b", "tj-new.json"),
			makeMinimalTrajectory("tj-new", "agent-b", 200),
		);
		await fs.writeFile(path.join(tmpDir, "notes.md"), "# scratch", "utf8");
		await fs.writeFile(
			path.join(tmpDir, "tj-partial.json.tmp"),
			"{ interrupted",
			"utf8",
		);

		const recorder = createJsonFileTrajectoryRecorder({
			rootDir: tmpDir,
			enabled: true,
		});

		const all = await recorder.list();
		expect(all.map((entry) => entry.trajectoryId)).toEqual([
			"tj-new",
			"tj-old",
		]);

		const filtered = await recorder.list({ agentId: "agent-a" });
		expect(filtered.map((entry) => entry.trajectoryId)).toEqual(["tj-old"]);

		await expect(recorder.load("tj-new")).resolves.toMatchObject({
			trajectoryId: "tj-new",
			agentId: "agent-b",
			startedAt: 200,
		});
	});
});

describe("getNoopTrajectoryRecorder", () => {
	it("hands out the same disabled instance whose methods never touch storage", async () => {
		const first = getNoopTrajectoryRecorder();
		expect(getNoopTrajectoryRecorder()).toBe(first);

		const id = first.startTrajectory({
			agentId: "agent-noop",
			rootMessage: { id: "r", text: "t" },
		});
		expect(id.startsWith("tj-noop-")).toBe(true);
		await expect(
			first.recordStage(id, {} as RecordedStage),
		).resolves.toBeUndefined();
		await expect(first.endTrajectory(id, "finished")).resolves.toBeUndefined();
		await expect(first.load(id)).resolves.toBeNull();
		await expect(first.list()).resolves.toEqual([]);
	});
});

describe("projectRecordedStageToolDiagnostics projection branches", () => {
	const redactSecrets = (text: string): string =>
		text.split("hunter2").join("[REDACTED]");

	it("projects every tool-stage surface: args, result, error, input, output, errorText", () => {
		const stage: RecordedStage = {
			stageId: "stage-tool",
			kind: "tool",
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
			tool: {
				name: "send-payment",
				args: { password: "hunter2" },
				result: { token: "hunter2" },
				success: true,
				durationMs: 5,
				error: "failed for hunter2",
				input: "input hunter2",
				output: "output hunter2",
				errorText: "errorText hunter2",
			},
		};

		projectRecordedStageToolDiagnostics(stage, redactSecrets);

		expect(stage.tool?.args).toEqual({ password: "[REDACTED]" });
		expect(stage.tool?.result).toEqual({ token: "[REDACTED]" });
		expect(stage.tool?.error).toBe("failed for [REDACTED]");
		expect(stage.tool?.input).toBe("input [REDACTED]");
		expect(stage.tool?.output).toBe("output [REDACTED]");
		expect(stage.tool?.errorText).toBe("errorText [REDACTED]");
		const serialized = JSON.stringify(stage);
		expect(serialized).not.toContain("hunter2");
	});

	it("projects model prompt, response, messages, and tool-call args, and drops provider spans when the prompt changes", () => {
		const stage: RecordedStage = {
			stageId: "stage-model",
			kind: "planner",
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
			model: {
				modelType: "TEXT_SMALL",
				prompt: "prompt hunter2",
				response: "response hunter2",
				messages: [{ role: "user", content: "message hunter2" }],
				toolCalls: [{ id: "call-1", name: "act", args: { k: "hunter2" } }],
				providerAttributions: [
					{
						providerName: "provider-1",
						sha256: "a".repeat(64),
						tokenCount: 3,
						position: 0,
						spanStart: 0,
						spanEnd: 6,
					},
				],
			},
		};

		projectRecordedStageToolDiagnostics(stage, redactSecrets);

		expect(stage.model?.prompt).toBe("prompt [REDACTED]");
		expect(stage.model?.response).toBe("response [REDACTED]");
		expect(stage.model?.messages).toEqual([
			{ role: "user", content: "message [REDACTED]" },
		]);
		expect(stage.model?.toolCalls?.[0]?.args).toEqual({ k: "[REDACTED]" });

		const attribution = stage.model?.providerAttributions?.[0];
		expect(attribution?.providerName).toBe("provider-1");
		expect(attribution?.sha256).toBe("a".repeat(64));
		expect(attribution?.tokenCountEstimated).toBe(true);
		expect("spanStart" in (attribution ?? {})).toBe(false);
		expect("spanEnd" in (attribution ?? {})).toBe(false);
	});

	it("leaves stages without tool/model/evaluation payload unchanged", () => {
		const stage: RecordedStage = {
			stageId: "stage-empty",
			kind: "cache",
			startedAt: 1,
			endedAt: 2,
			latencyMs: 1,
			cache: { segmentHashes: ["hash-1"], prefixHash: "prefix-1" },
		};
		const before = JSON.stringify(stage);

		projectRecordedStageToolDiagnostics(stage, redactSecrets);

		expect(JSON.stringify(stage)).toBe(before);
	});
});

describe("markdown review rendering edges", () => {
	it("summarizes numeric TEXT_EMBEDDING responses, keeps non-numeric ones raw, and escalates fences for content that contains ```", async () => {
		process.env.ELIZA_TRAJECTORY_REVIEW_MODE = "1";
		const recorder = createJsonFileTrajectoryRecorder({
			rootDir: tmpDir,
			enabled: true,
		});
		const id = recorder.startTrajectory({
			agentId: "agent-md",
			rootMessage: { id: "m1", text: "```js\nconsole.log(1)\n```" },
		});

		await recorder.recordStage(id, {
			stageId: "stage-embed",
			kind: "planner",
			startedAt: 1_000,
			endedAt: 2_500,
			latencyMs: 1_500,
			model: {
				modelType: "TEXT_EMBEDDING",
				response: "[0.5, 0.25]",
			},
		});
		await recorder.recordStage(id, {
			stageId: "stage-embed-nonnumeric",
			kind: "planner",
			startedAt: 3_000,
			endedAt: 3_001,
			latencyMs: 1,
			model: {
				modelType: "TEXT_EMBEDDING",
				response: '[1, "two"]',
			},
		});
		await recorder.endTrajectory(id, "finished");

		const markdown = await fs.readFile(
			path.join(tmpDir, "agent-md", `${id}.md`),
			"utf8",
		);
		expect(markdown).toContain(
			"Embedding vector (2 dimensions). Preview: [0.5000, 0.2500]",
		);
		expect(markdown).toContain('[1, "two"]');
		expect(markdown).toContain("````");
		expect(markdown).toContain("- total: 1.50s");
	});

	it("renders a dash for a missing endedAt timestamp", async () => {
		process.env.ELIZA_TRAJECTORY_REVIEW_MODE = "1";
		const recorder = createJsonFileTrajectoryRecorder({
			rootDir: tmpDir,
			enabled: true,
		});
		const id = recorder.startTrajectory({
			agentId: "agent-md-2",
			rootMessage: { id: "m2", text: "still running" },
		});
		await recorder.recordStage(id, {
			stageId: "stage-only",
			kind: "messageHandler",
			startedAt: 10,
			endedAt: 11,
			latencyMs: 1,
		});

		const markdown = await fs.readFile(
			path.join(tmpDir, "agent-md-2", `${id}.md`),
			"utf8",
		);
		expect(markdown).toContain("- ended: -");
		expect(markdown).toContain("- latency: 1ms");
	});
});

describe("encodeTrajectoryFieldValue type matrix", () => {
	it("passes strings through and encodes undefined/null as empty strings", () => {
		expect(encodeTrajectoryFieldValue("plain")).toBe("plain");
		expect(encodeTrajectoryFieldValue(undefined)).toBe("");
		expect(encodeTrajectoryFieldValue(null)).toBe("");
	});

	it("sanitizes scalar edge types into JSON-safe values", () => {
		expect(encodeTrajectoryFieldValue(42n)).toBe('"42"');
		expect(JSON.parse(encodeTrajectoryFieldValue(Number.NaN))).toBeNull();
		expect(JSON.parse(encodeTrajectoryFieldValue(new Date(0)))).toBe(
			"1970-01-01T00:00:00.000Z",
		);
		expect(JSON.parse(encodeTrajectoryFieldValue(Symbol("tag")))).toBe(
			"Symbol(tag)",
		);
		function doThing(): void {}
		expect(JSON.parse(encodeTrajectoryFieldValue(doThing))).toBe(
			"[Function doThing]",
		);
		expect(JSON.parse(encodeTrajectoryFieldValue(() => {}))).toBe(
			"[Function anonymous]",
		);
	});

	it("sanitizes collections, binary views, errors, and circular references structurally", () => {
		expect(JSON.parse(encodeTrajectoryFieldValue(new Map([["a", 1]])))).toEqual(
			{
				a: 1,
			},
		);
		expect(JSON.parse(encodeTrajectoryFieldValue(new Set([1, 2])))).toEqual([
			1, 2,
		]);
		expect(JSON.parse(encodeTrajectoryFieldValue(/ab/g))).toBe("/ab/g");
		expect(JSON.parse(encodeTrajectoryFieldValue(new ArrayBuffer(4)))).toEqual({
			type: "ArrayBuffer",
			byteLength: 4,
		});
		const view = new Uint8Array(4);
		expect(JSON.parse(encodeTrajectoryFieldValue(view))).toEqual({
			type: "Uint8Array",
			byteLength: 4,
		});
		const failure = new Error("boom");
		const decodedError = JSON.parse(encodeTrajectoryFieldValue(failure)) as {
			name: string;
			message: string;
		};
		expect(decodedError.name).toBe("Error");
		expect(decodedError.message).toBe("boom");
		const circular: Record<string, unknown> = { label: "root" };
		circular.self = circular;
		const decodedCircular = JSON.parse(
			encodeTrajectoryFieldValue(circular),
		) as { label: string; self: unknown };
		expect(decodedCircular.label).toBe("root");
		expect(decodedCircular.self).toBe("[Circular]");
	});
});
