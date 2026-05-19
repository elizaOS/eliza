import type { IAgentRuntime, Memory } from "@elizaos/core";
import {
	annotateActiveTrajectoryStep,
	getTrajectoryContext,
	logger,
} from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSkillAction } from "./use-skill";

const mockedAnnotateActiveTrajectoryStep = vi.mocked(
	annotateActiveTrajectoryStep,
);
const mockedGetTrajectoryContext = vi.mocked(getTrajectoryContext);

beforeEach(() => {
	mockedAnnotateActiveTrajectoryStep.mockClear();
	mockedGetTrajectoryContext.mockReset();
	mockedGetTrajectoryContext.mockReturnValue(undefined);
	(logger.info as ReturnType<typeof vi.fn>).mockClear?.();
});

describe("useSkillAction", () => {
	it("reads planned action arguments from handler parameters", async () => {
		const skill = {
			slug: "github",
			name: "GitHub",
			description: "GitHub workflow guidance",
			version: "1.0.0",
			content: "",
			frontmatter: {},
			path: "/skills/github",
			scripts: [],
			references: [],
			assets: [],
			loadedAt: 0,
			source: "bundled",
		};
		const service = {
			getLoadedSkill: vi.fn((slug: string) =>
				slug === "github" ? skill : undefined,
			),
			getLoadedSkills: vi.fn(() => [skill]),
			isSkillEnabled: vi.fn(() => true),
			checkSkillEligibility: vi.fn(async () => ({
				slug: "github",
				eligible: true,
				reasons: [],
				checkedAt: 0,
			})),
			getSkillInstructions: vi.fn(() => ({
				slug: "github",
				body: "Use the repository host's API and local git state.",
				estimatedTokens: 12,
			})),
		};
		const runtimeShape = {
			getService: vi.fn((name: string) =>
				name === "AGENT_SKILLS_SERVICE" ? service : undefined,
			),
		};
		const callback = vi.fn();

		const result = await useSkillAction.handler(
			Object.assign(Object.create(null) as IAgentRuntime, runtimeShape),
			{ content: { text: "use github skill" } } as Memory,
			undefined,
			{ parameters: { slug: "github", mode: "guidance" } },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.data).toMatchObject({
			slug: "github",
			mode: "guidance",
		});
		expect(callback).toHaveBeenCalledWith({
			text: expect.stringContaining("Use the repository host's API"),
			actions: ["USE_SKILL"],
		});
		expect(service.getLoadedSkill).toHaveBeenCalledWith("github");
	});

	it("appends a per-skill invocation record with input/output when a trajectory step is active (W1-T5)", async () => {
		mockedGetTrajectoryContext.mockReturnValue({
			trajectoryStepId: "step-skill-1",
		});

		const skill = {
			slug: "weather",
			name: "Weather",
			description: "Weather guidance",
			version: "1.0.0",
			content: "",
			frontmatter: {},
			path: "/skills/weather",
			scripts: [],
			references: [],
			assets: [],
			loadedAt: 0,
			source: "bundled",
		};
		const service = {
			getLoadedSkill: vi.fn(() => skill),
			getLoadedSkills: vi.fn(() => [skill]),
			isSkillEnabled: vi.fn(() => true),
			checkSkillEligibility: vi.fn(async () => ({
				slug: "weather",
				eligible: true,
				reasons: [],
				checkedAt: 0,
			})),
			getSkillInstructions: vi.fn(() => ({
				slug: "weather",
				body: "Call the weather service.",
				estimatedTokens: 7,
			})),
		};
		const runtimeShape = {
			getService: vi.fn((name: string) =>
				name === "AGENT_SKILLS_SERVICE" ? service : undefined,
			),
		};

		const result = await useSkillAction.handler(
			Object.assign(Object.create(null) as IAgentRuntime, runtimeShape),
			{ content: { text: "use weather skill" } } as Memory,
			undefined,
			{ parameters: { slug: "weather", mode: "guidance" } },
			vi.fn(),
		);

		expect(result?.success).toBe(true);

		// The first annotate writes usedSkills, the second the invocation record.
		expect(mockedAnnotateActiveTrajectoryStep).toHaveBeenCalledTimes(2);

		const invocationCall =
			mockedAnnotateActiveTrajectoryStep.mock.calls.at(-1);
		expect(invocationCall).toBeDefined();
		const annotateParams = invocationCall?.[1] as {
			stepId: string;
			appendSkillInvocations: Array<{
				skillSlug: string;
				args?: string;
				result?: string;
				durationMs: number;
				parentStepId: string;
				mode: string;
				success: boolean;
				startedAt: number;
			}>;
		};
		expect(annotateParams.stepId).toBe("step-skill-1");
		expect(annotateParams.appendSkillInvocations).toHaveLength(1);

		const invocation = annotateParams.appendSkillInvocations[0];
		expect(invocation.skillSlug).toBe("weather");
		expect(invocation.parentStepId).toBe("step-skill-1");
		expect(invocation.mode).toBe("guidance");
		expect(invocation.success).toBe(true);
		expect(invocation.args).toBe(JSON.stringify({ mode: "guidance" }));
		expect(invocation.result).toContain("Call the weather service");
		expect(invocation.result).toContain("estimatedTokens");
		expect(invocation.durationMs).toBeGreaterThanOrEqual(0);
		expect(typeof invocation.startedAt).toBe("number");
	});

	it("emits a structured truncation marker when result exceeds the 64KB cap (W1-T5)", async () => {
		mockedGetTrajectoryContext.mockReturnValue({
			trajectoryStepId: "step-skill-trunc",
		});

		// 150KB of instructions: well over the 64KB cap. The first 3500 chars
		// are returned to the user but the full body is captured into the
		// invocation record before the cap is applied.
		const hugeBody = "x".repeat(150_000);
		const skill = {
			slug: "huge",
			name: "Huge",
			description: "Massive output skill",
			version: "1.0.0",
			content: "",
			frontmatter: {},
			path: "/skills/huge",
			scripts: [],
			references: [],
			assets: [],
			loadedAt: 0,
			source: "bundled",
		};
		const service = {
			getLoadedSkill: vi.fn(() => skill),
			getLoadedSkills: vi.fn(() => [skill]),
			isSkillEnabled: vi.fn(() => true),
			checkSkillEligibility: vi.fn(async () => ({
				slug: "huge",
				eligible: true,
				reasons: [],
				checkedAt: 0,
			})),
			getSkillInstructions: vi.fn(() => ({
				slug: "huge",
				body: hugeBody,
				estimatedTokens: 50_000,
			})),
		};
		const runtimeShape = {
			getService: vi.fn(() => service),
		};

		await useSkillAction.handler(
			Object.assign(Object.create(null) as IAgentRuntime, runtimeShape),
			{ content: { text: "use huge skill" } } as Memory,
			undefined,
			{ parameters: { slug: "huge", mode: "guidance" } },
			vi.fn(),
		);

		const lastCall = mockedAnnotateActiveTrajectoryStep.mock.calls.at(-1);
		const annotateParams = lastCall?.[1] as {
			appendSkillInvocations: Array<{
				result?: string;
				truncated?: Array<{
					field: string;
					originalBytes: number;
					capBytes: number;
				}>;
			}>;
		};
		const invocation = annotateParams.appendSkillInvocations[0];
		expect(invocation.result?.endsWith("...[truncated]")).toBe(true);
		// 64KB cap: 65_536 bytes (no override env set in tests).
		expect(Buffer.byteLength(invocation.result ?? "", "utf8")).toBeLessThanOrEqual(
			65_536,
		);
		expect(invocation.truncated).toBeDefined();
		const resultMarker = invocation.truncated?.find(
			(t) => t.field === "result",
		);
		expect(resultMarker).toBeDefined();
		expect(resultMarker?.capBytes).toBe(65_536);
		expect(resultMarker?.originalBytes).toBeGreaterThan(65_536);
	});

	it("skips invocation capture when no trajectory step is active", async () => {
		mockedGetTrajectoryContext.mockReturnValue(undefined);
		const skill = {
			slug: "noop",
			name: "Noop",
			description: "noop",
			version: "1.0.0",
			content: "",
			frontmatter: {},
			path: "/skills/noop",
			scripts: [],
			references: [],
			assets: [],
			loadedAt: 0,
			source: "bundled",
		};
		const service = {
			getLoadedSkill: vi.fn(() => skill),
			getLoadedSkills: vi.fn(() => [skill]),
			isSkillEnabled: vi.fn(() => true),
			checkSkillEligibility: vi.fn(async () => ({
				slug: "noop",
				eligible: true,
				reasons: [],
				checkedAt: 0,
			})),
			getSkillInstructions: vi.fn(() => ({
				slug: "noop",
				body: "body",
				estimatedTokens: 1,
			})),
		};
		const runtimeShape = {
			getService: vi.fn(() => service),
		};

		const result = await useSkillAction.handler(
			Object.assign(Object.create(null) as IAgentRuntime, runtimeShape),
			{ content: { text: "use noop skill" } } as Memory,
			undefined,
			{ parameters: { slug: "noop", mode: "guidance" } },
			vi.fn(),
		);

		expect(result?.success).toBe(true);
		expect(mockedAnnotateActiveTrajectoryStep).not.toHaveBeenCalled();
	});
});
