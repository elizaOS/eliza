/**
 * Synthetic-trajectory tests for the skillExtraction evaluator.
 *
 * No mocked SQL — the evaluator only needs `runtime.useModel`,
 * `runtime.getService("trajectories")`, and `runtime.createMemory`. We stub
 * the runtime with a tiny in-memory shim so tests stay deterministic and
 * fast.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, UUID } from "../../../../types/index.ts";
import { skillExtractionEvaluator } from "../skillExtraction.ts";

interface StubTrajectoryServiceOptions {
	id?: string;
	stepCount?: number;
	usedSkills?: string[];
	status?: string;
}

function makeStubRuntime(opts: {
	stateDir: string;
	trajectory?: StubTrajectoryServiceOptions;
	llmResponse?: string;
}) {
	const trajectoryId = opts.trajectory?.id ?? "traj-001";
	const stepCount = opts.trajectory?.stepCount ?? 6;
	const status = opts.trajectory?.status ?? "completed";
	const usedSkills = opts.trajectory?.usedSkills ?? [];

	const trajectoryDetail = {
		trajectoryId,
		agentId: "agent-001",
		startTime: 1,
		endTime: 100,
		metrics: { finalStatus: status },
		steps: Array.from({ length: stepCount }, (_, i) => ({
			timestamp: i,
			usedSkills,
			llmCalls: [
				{
					purpose: "demo_step",
					userPrompt: `prompt ${i}`,
					response: `response ${i}`,
				},
			],
		})),
		metadata: {},
	};

	const stubService = {
		listTrajectories: async () => ({
			trajectories: [
				{
					id: trajectoryId,
					status,
					stepCount,
					endTime: 100,
				},
			],
		}),
		getTrajectoryDetail: async () => trajectoryDetail,
	};

	const memories: Memory[] = [];

	const runtime: Partial<IAgentRuntime> = {
		agentId: "agent-001" as UUID,
		getService: ((serviceType: string) => {
			if (serviceType === "trajectories") return stubService;
			return null;
			// biome-ignore lint/suspicious/noExplicitAny: Mock signature is intentional.
		}) as any,
		useModel: (async () =>
			opts.llmResponse ??
			'```json\n{ "extract": false, "reason": "no signal" }\n```') as IAgentRuntime["useModel"],
		createMemory: (async (memory: Memory) => {
			memories.push(memory);
			return "mem-001" as UUID;
		}) as IAgentRuntime["createMemory"],
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
			fatal: () => {},
			trace: () => {},
		} as IAgentRuntime["logger"],
	};

	return {
		runtime: runtime as IAgentRuntime,
		memories,
		stateDir: opts.stateDir,
	};
}

function makeMessage(): Memory {
	return {
		entityId: "user-001" as UUID,
		agentId: "agent-001" as UUID,
		roomId: "room-001" as UUID,
		content: { text: "hello" },
	} satisfies Memory;
}

let prevStateDir: string | undefined;
let prevElizaStateDir: string | undefined;
let stateDir: string;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "skill-extract-"));
	prevStateDir = process.env.MILADY_STATE_DIR;
	prevElizaStateDir = process.env.ELIZA_STATE_DIR;
	process.env.MILADY_STATE_DIR = stateDir;
	delete process.env.ELIZA_STATE_DIR;
});

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.MILADY_STATE_DIR;
	else process.env.MILADY_STATE_DIR = prevStateDir;
	if (prevElizaStateDir !== undefined)
		process.env.ELIZA_STATE_DIR = prevElizaStateDir;
	rmSync(stateDir, { recursive: true, force: true });
});

describe("skillExtractionEvaluator", () => {
	it("validate() rejects trajectories that already used a curated skill", async () => {
		const { runtime } = makeStubRuntime({
			stateDir,
			trajectory: { usedSkills: ["preexisting-skill"] },
		});
		const ok = await skillExtractionEvaluator.validate(runtime, makeMessage());
		expect(ok).toBe(false);
	});

	it("validate() accepts a long completed trajectory with no skill use", async () => {
		const { runtime } = makeStubRuntime({ stateDir });
		const ok = await skillExtractionEvaluator.validate(runtime, makeMessage());
		expect(ok).toBe(true);
	});

	it("validate() rejects trajectories with too few steps", async () => {
		const { runtime } = makeStubRuntime({
			stateDir,
			trajectory: { stepCount: 2 },
		});
		const ok = await skillExtractionEvaluator.validate(runtime, makeMessage());
		expect(ok).toBe(false);
	});

	it("handler() stages a SKILL.md when the LLM extracts a skill", async () => {
		const llmResponse =
			'```json\n{ "extract": true, "name": "demo-skill", "description": "demo", "body": "## body\\n\\n1. step" }\n```';
		const { runtime, memories } = makeStubRuntime({
			stateDir,
			llmResponse,
		});

		const result = await skillExtractionEvaluator.handler(
			runtime,
			makeMessage(),
		);
		expect(result?.success).toBe(true);

		const stagedPath = join(
			stateDir,
			"skills",
			"curated",
			"proposed",
			"demo-skill",
			"SKILL.md",
		);
		expect(existsSync(stagedPath)).toBe(true);
		const text = readFileSync(stagedPath, "utf-8");
		expect(text).toMatch(/source: agent-generated/);
		expect(text).toMatch(/derivedFromTrajectory: traj-001/);
		expect(text).toMatch(/refinedCount: 0/);
		expect(text).toMatch(/## body/);

		expect(memories.length).toBe(1);
		expect(memories[0]?.content?.text).toMatch(/Learned Skills/);
	});

	it("handler() refuses to clobber an existing proposed skill", async () => {
		const llmResponse =
			'```json\n{ "extract": true, "name": "demo-skill", "description": "demo", "body": "## body" }\n```';
		const { runtime } = makeStubRuntime({ stateDir, llmResponse });

		const first = await skillExtractionEvaluator.handler(
			runtime,
			makeMessage(),
		);
		expect(first?.success).toBe(true);

		const second = await skillExtractionEvaluator.handler(
			runtime,
			makeMessage(),
		);
		expect(second).toBeUndefined();
	});

	it("handler() rejects invalid skill names", async () => {
		const llmResponse =
			'```json\n{ "extract": true, "name": "Bad Name!", "description": "demo", "body": "## body" }\n```';
		const { runtime } = makeStubRuntime({ stateDir, llmResponse });

		const result = await skillExtractionEvaluator.handler(
			runtime,
			makeMessage(),
		);
		expect(result).toBeUndefined();
	});
});
