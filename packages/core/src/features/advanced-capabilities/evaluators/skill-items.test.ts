/**
 * Deterministic unit coverage for the skill-learning evaluators, including
 * trajectory selection and caching, proposal/refinement gates and parsing, and
 * real SKILL.md persistence in an isolated state directory. The trajectory
 * store and runtime boundary are lightweight fakes; filesystem behavior is real.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	EvaluatorProcessorContext,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import {
	_countProposedSkills,
	_splitFrontmatter,
	skillItems,
	skillProposalEvaluator,
	skillRefinementEvaluator,
} from "./skill-items.ts";
import type {
	SkillTrajectory,
	SkillTrajectoryListItem,
	SkillTrajectoryService,
} from "./trajectory-evaluator-utils.ts";

const AGENT_ID = "00000000-0000-4000-8000-0000000000a1" as UUID;
const ENTITY_ID = "00000000-0000-4000-8000-0000000000e1" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-0000000000b1" as UUID;
const STATE: State = { values: {}, data: {}, text: "" };

let stateDir: string;
let messageSequence = 0;

beforeEach(() => {
	stateDir = mkdtempSync(join(tmpdir(), "eliza-skill-items-"));
	process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
	delete process.env.ELIZA_STATE_DIR;
	rmSync(stateDir, { recursive: true, force: true });
});

function message(): Memory {
	messageSequence += 1;
	return {
		id: `00000000-0000-4000-8000-${messageSequence.toString().padStart(12, "0")}` as UUID,
		entityId: ENTITY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: { text: "done" },
		createdAt: Date.now(),
	};
}

function trajectory(overrides: Partial<SkillTrajectory> = {}): SkillTrajectory {
	return {
		trajectoryId: "trajectory-1",
		agentId: AGENT_ID,
		startTime: 1,
		endTime: 10,
		steps: Array.from({ length: 5 }, (_, index) => ({
			stepId: `step-${index + 1}`,
			timestamp: index + 1,
			llmCalls: [],
		})),
		metrics: { finalStatus: "completed" },
		metadata: {},
		...overrides,
	};
}

function listItem(id: string, endTime: number | null): SkillTrajectoryListItem {
	return { id, status: "completed", endTime };
}

function makeRuntime(
	items: SkillTrajectoryListItem[] = [listItem("trajectory-1", 10)],
	details: Record<string, SkillTrajectory | null> = {
		"trajectory-1": trajectory(),
	},
) {
	const service: SkillTrajectoryService = {
		listTrajectories: vi.fn(async () => ({ trajectories: items })),
		getTrajectoryDetail: vi.fn(async (id) => details[id] ?? null),
	};
	const runtime = {
		agentId: AGENT_ID,
		getService: vi.fn((name: string) =>
			name === "trajectories" ? service : null,
		),
		createMemory: vi.fn(async () => undefined),
		reportError: vi.fn(),
	} as unknown as IAgentRuntime & {
		getService: ReturnType<typeof vi.fn>;
		createMemory: ReturnType<typeof vi.fn>;
		reportError: ReturnType<typeof vi.fn>;
	};
	return { runtime, service };
}

function activeSkillPath(name: string, refinedCount = 0): string {
	const directory = join(stateDir, "skills", "curated", "active", name);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, "SKILL.md");
	writeFileSync(
		path,
		`---\nname: ${name}\ndescription: existing skill\nprovenance:\n  source: human\n  refinedCount: ${refinedCount}\n---\n\n# Existing body\n`,
		"utf8",
	);
	return path;
}

describe("skill evaluator registration and trajectory selection", () => {
	it("exports proposal before refinement with distinct priorities", () => {
		expect(skillItems).toEqual([
			skillProposalEvaluator,
			skillRefinementEvaluator,
		]);
		expect(skillProposalEvaluator.priority).not.toBe(
			skillRefinementEvaluator.priority,
		);
	});

	it("returns false when the service or trajectory list is empty", async () => {
		const noService = {
			agentId: AGENT_ID,
			getService: () => null,
		} as unknown as IAgentRuntime;
		expect(
			await skillProposalEvaluator.shouldRun({
				runtime: noService,
				message: message(),
				options: {},
			}),
		).toBe(false);

		const { runtime } = makeRuntime([], {});
		expect(
			await skillRefinementEvaluator.shouldRun({
				runtime,
				message: message(),
				options: {},
			}),
		).toBe(false);
	});

	it("selects the greatest endTime, treating null as zero and preserving the first tie", async () => {
		const first = trajectory({ trajectoryId: "first-tie" });
		const { runtime, service } = makeRuntime(
			[
				listItem("null-time", null),
				listItem("first-tie", 20),
				listItem("second-tie", 20),
			],
			{
				"null-time": trajectory({ trajectoryId: "null-time" }),
				"first-tie": first,
				"second-tie": trajectory({ trajectoryId: "second-tie" }),
			},
		);
		expect(
			await skillProposalEvaluator.shouldRun({
				runtime,
				message: message(),
				options: {},
			}),
		).toBe(true);
		expect(service.getTrajectoryDetail).toHaveBeenCalledWith("first-tie");
	});

	it("memoizes shouldRun and prepare for one message, then evicts the oldest of 33 messages", async () => {
		const { runtime, service } = makeRuntime();
		const firstMessage = message();
		await skillProposalEvaluator.shouldRun({
			runtime,
			message: firstMessage,
			options: {},
		});
		await skillProposalEvaluator.prepare?.({
			runtime,
			message: firstMessage,
			state: STATE,
			options: {},
		});
		expect(service.listTrajectories).toHaveBeenCalledTimes(1);

		for (let index = 0; index < 32; index += 1) {
			await skillProposalEvaluator.shouldRun({
				runtime,
				message: message(),
				options: {},
			});
		}
		await skillProposalEvaluator.shouldRun({
			runtime,
			message: firstMessage,
			options: {},
		});
		expect(service.listTrajectories).toHaveBeenCalledTimes(34);
	});
});

describe("skill proposal evaluator", () => {
	it("requires a completed five-step trajectory with no curated skill", async () => {
		for (const [candidate, expected] of [
			[trajectory(), true],
			[trajectory({ steps: trajectory().steps?.slice(0, 4) }), false],
			[trajectory({ metrics: { finalStatus: "failed" } }), false],
			[
				trajectory({
					steps: [{ timestamp: 1, usedSkills: ["existing-skill"] }],
				}),
				false,
			],
			[trajectory({ metadata: { usedSkills: ["existing-skill"] } }), false],
		] as const) {
			const { runtime } = makeRuntime(undefined, {
				"trajectory-1": candidate,
			});
			expect(
				await skillProposalEvaluator.shouldRun({
					runtime,
					message: message(),
					options: {},
				}),
			).toBe(expected);
		}
	});

	it("parses valid fields tolerantly and rejects non-object envelopes", () => {
		expect(skillProposalEvaluator.parse?.(null)).toBeNull();
		expect(skillProposalEvaluator.parse?.([])).toBeNull();
		expect(
			skillProposalEvaluator.parse?.({ extract: true, reason: 7, name: 8 }),
		).toEqual({
			extract: true,
			reason: "",
			name: undefined,
			description: undefined,
			body: undefined,
		});
	});

	it("writes a real proposal with provenance and emits its user notice", async () => {
		const { runtime } = makeRuntime();
		const inputMessage = message();
		const prepared = await skillProposalEvaluator.prepare?.({
			runtime,
			message: inputMessage,
			state: STATE,
			options: {},
		});
		if (!prepared) throw new Error("missing proposal preparation");
		const processor = skillProposalEvaluator.processors?.[0];
		if (!processor) throw new Error("missing proposal processor");
		const result = await processor.process({
			runtime,
			message: inputMessage,
			state: STATE,
			options: {},
			evaluatorName: skillProposalEvaluator.name,
			prepared,
			output: {
				extract: true,
				reason: "reusable",
				name: "release-checklist",
				description: "Checks a release before publishing.",
				body: "# Release checklist\n\n1. Run tests.",
			},
		});

		const content = readFileSync(
			join(
				stateDir,
				"skills",
				"curated",
				"proposed",
				"release-checklist",
				"SKILL.md",
			),
			"utf8",
		);
		expect(_splitFrontmatter(content)).toMatchObject({
			frontmatter: {
				name: "release-checklist",
				description: "Checks a release before publishing.",
				provenance: {
					source: "agent-generated",
					derivedFromTrajectory: "trajectory-1",
					refinedCount: 0,
				},
			},
			body: "# Release checklist\n\n1. Run tests.\n",
		});
		expect(runtime.createMemory).toHaveBeenCalledWith(
			expect.objectContaining({
				roomId: ROOM_ID,
				metadata: expect.objectContaining({
					source: "skill_proposal_notice",
				}),
			}),
			"messages",
		);
		expect(result?.values).toMatchObject({
			skillProposalName: "release-checklist",
		});
	});

	it("rejects invalid names, overlong descriptions, body delimiters, and duplicates", async () => {
		const { runtime } = makeRuntime();
		const prepared = await skillProposalEvaluator.prepare?.({
			runtime,
			message: message(),
			state: STATE,
			options: {},
		});
		const processor = skillProposalEvaluator.processors?.[0];
		if (!prepared || !processor)
			throw new Error("missing proposal evaluator parts");
		const base = {
			runtime,
			message: message(),
			state: STATE,
			options: {},
			evaluatorName: skillProposalEvaluator.name,
			prepared,
		};
		for (const output of [
			{ extract: false, reason: "no" },
			{
				extract: true,
				reason: "bad name",
				name: "Bad_Name",
				description: "valid",
				body: "body",
			},
			{
				extract: true,
				reason: "long",
				name: "valid-name",
				description: "x".repeat(201),
				body: "body",
			},
			{
				extract: true,
				reason: "delimiter",
				name: "valid-name",
				description: "valid",
				body: "body\n---\nextra",
			},
		]) {
			expect(await processor.process({ ...base, output })).toBeUndefined();
		}

		activeSkillPath("existing-name");
		expect(
			await processor.process({
				...base,
				output: {
					extract: true,
					reason: "duplicate",
					name: "existing-name",
					description: "valid",
					body: "body",
				},
			}),
		).toBeUndefined();
		expect(_countProposedSkills()).toBe(0);
	});

	it("reports a failed notice without discarding the written proposal", async () => {
		const { runtime } = makeRuntime();
		runtime.createMemory.mockRejectedValueOnce(new Error("notice unavailable"));
		const inputMessage = message();
		const prepared = await skillProposalEvaluator.prepare?.({
			runtime,
			message: inputMessage,
			state: STATE,
			options: {},
		});
		const processor = skillProposalEvaluator.processors?.[0];
		if (!prepared || !processor)
			throw new Error("missing proposal evaluator parts");
		const result = await processor.process({
			runtime,
			message: inputMessage,
			state: STATE,
			options: {},
			evaluatorName: skillProposalEvaluator.name,
			prepared,
			output: {
				extract: true,
				reason: "reusable",
				name: "notice-failure",
				description: "Still writes the proposal.",
				body: "# Body",
			},
		});
		expect(result?.success).toBe(true);
		expect(runtime.reportError).toHaveBeenCalledWith(
			"SkillItemsEvaluator.proposalNotice",
			expect.any(Error),
			{ roomId: ROOM_ID },
		);
	});
});

describe("skill refinement evaluator", () => {
	it("runs only for a failed or retried trajectory that used a named skill", async () => {
		for (const [candidate, expected] of [
			[
				trajectory({
					metrics: { finalStatus: "failed" },
					metadata: { usedSkills: [" one ", "", "one"] },
				}),
				true,
			],
			[
				trajectory({
					metadata: { retryCount: 1, usedSkills: ["one"] },
				}),
				true,
			],
			[
				trajectory({
					metadata: { retryDetected: true, usedSkills: ["one"] },
				}),
				true,
			],
			[trajectory({ metadata: { retryCount: 0, usedSkills: ["one"] } }), false],
			[trajectory({ metrics: { finalStatus: "failed" } }), false],
		] as const) {
			const { runtime } = makeRuntime(undefined, {
				"trajectory-1": candidate,
			});
			expect(
				await skillRefinementEvaluator.shouldRun({
					runtime,
					message: message(),
					options: {},
				}),
			).toBe(expected);
		}
	});

	it("deduplicates skill names and prepares only real, parseable active files", async () => {
		activeSkillPath("one");
		const invalidDir = join(stateDir, "skills", "curated", "active", "invalid");
		mkdirSync(invalidDir, { recursive: true });
		writeFileSync(join(invalidDir, "SKILL.md"), "not frontmatter", "utf8");
		const usedTrajectory = trajectory({
			metrics: { finalStatus: "failed" },
			steps: [{ timestamp: 1, usedSkills: [" one ", "missing", "one"] }],
			metadata: { usedSkills: ["invalid"] },
		});
		const { runtime } = makeRuntime(undefined, {
			"trajectory-1": usedTrajectory,
		});
		const prepared = await skillRefinementEvaluator.prepare?.({
			runtime,
			message: message(),
			state: STATE,
			options: {},
		});
		expect(prepared?.skills.map((skill) => skill.name)).toEqual(["one"]);
		expect(prepared?.trajectoryDigest).toContain("Final status: failed");
	});

	it("parses refinement objects while dropping malformed entries and empty names", () => {
		expect(skillRefinementEvaluator.parse?.(null)).toBeNull();
		expect(skillRefinementEvaluator.parse?.({ refinements: "no" })).toBeNull();
		expect(
			skillRefinementEvaluator.parse?.({
				refinements: [
					null,
					"bad",
					{ skillName: "", refine: true },
					{ skillName: "one", refine: 1, reason: 2, newBody: 3 },
				],
			}),
		).toEqual({
			refinements: [
				{
					skillName: "one",
					refine: false,
					reason: "",
					newBody: undefined,
				},
			],
		});
	});

	it("rewrites an active skill and increments refinement provenance", async () => {
		const skillPath = activeSkillPath("one", 2);
		const usedTrajectory = trajectory({
			trajectoryId: "failed-trajectory",
			metrics: { finalStatus: "failed" },
			metadata: { usedSkills: ["one"] },
		});
		const { runtime } = makeRuntime(undefined, {
			"trajectory-1": usedTrajectory,
		});
		const prepared = await skillRefinementEvaluator.prepare?.({
			runtime,
			message: message(),
			state: STATE,
			options: {},
		});
		const processor = skillRefinementEvaluator.processors?.[0];
		if (!prepared || !processor) throw new Error("missing refinement parts");
		const result = await processor.process({
			runtime,
			message: message(),
			state: STATE,
			options: {},
			evaluatorName: skillRefinementEvaluator.name,
			prepared,
			output: {
				refinements: [
					{
						skillName: "one",
						refine: true,
						reason: "tighten",
						newBody: "# Safer body",
					},
				],
			},
		});
		const parsed = _splitFrontmatter(readFileSync(skillPath, "utf8"));
		expect(parsed).toMatchObject({
			frontmatter: {
				provenance: {
					source: "agent-refined",
					derivedFromTrajectory: "failed-trajectory",
					refinedCount: 3,
				},
			},
			body: "# Safer body\n",
		});
		expect(result?.data).toMatchObject({
			refinedSkills: ["one"],
			proposedSkills: [],
		});
	});

	it("stages the fourth refinement once and ignores missing or unsafe refinements", async () => {
		activeSkillPath("one", 3);
		const usedTrajectory = trajectory({
			trajectoryId: "fourth-failure",
			metrics: { finalStatus: "failed" },
			metadata: { usedSkills: ["one"] },
		});
		const { runtime } = makeRuntime(undefined, {
			"trajectory-1": usedTrajectory,
		});
		const prepared = await skillRefinementEvaluator.prepare?.({
			runtime,
			message: message(),
			state: STATE,
			options: {},
		});
		const processor = skillRefinementEvaluator.processors?.[0];
		if (!prepared || !processor) throw new Error("missing refinement parts");
		const context: EvaluatorProcessorContext = {
			runtime,
			message: message(),
			state: STATE,
			options: {},
			evaluatorName: skillRefinementEvaluator.name,
			prepared,
			output: {
				refinements: [
					{
						skillName: "missing",
						refine: true,
						reason: "not active",
						newBody: "body",
					},
					{
						skillName: "one",
						refine: true,
						reason: "unsafe",
						newBody: "body\n---\nextra",
					},
					{
						skillName: "one",
						refine: true,
						reason: "stage",
						newBody: "# Proposed fourth body",
					},
				],
			},
		};
		const result = await processor.process(
			context as Parameters<typeof processor.process>[0],
		);
		expect(result?.data).toMatchObject({
			refinedSkills: [],
			proposedSkills: ["one"],
		});
		expect(_countProposedSkills()).toBe(1);

		expect(
			await processor.process(
				context as Parameters<typeof processor.process>[0],
			),
		).toBeUndefined();
		expect(_countProposedSkills()).toBe(1);
	});
});

describe("proposed skill counting", () => {
	it("returns zero for a missing directory and counts directories but not files", () => {
		expect(_countProposedSkills()).toBe(0);
		const proposed = join(stateDir, "skills", "curated", "proposed");
		mkdirSync(join(proposed, "one"), { recursive: true });
		mkdirSync(join(proposed, "two"), { recursive: true });
		writeFileSync(join(proposed, "README.md"), "not a skill", "utf8");
		expect(_countProposedSkills()).toBe(2);
	});
});
