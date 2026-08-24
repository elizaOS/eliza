/**
 * Trajectory formatting feeds an extraction model, so the repository
 * prompt-integrity rule applies: the digest must carry every step and every
 * call complete, with no cap, window, or elision. These cases pin that
 * alongside the defensive service lookup (both methods required, else null)
 * and the tolerant JSON parser that treats malformed model output as an
 * explicit invalid result.
 */
import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../../types/index.ts";
import {
	formatTrajectoryForPrompt,
	getTrajectoryService,
	parseJsonObject,
	type SkillTrajectory,
} from "./trajectory-evaluator-utils.ts";

function runtimeWith(service: unknown): IAgentRuntime {
	return { getService: () => service } as unknown as IAgentRuntime;
}

const trajectory = (over: Partial<SkillTrajectory> = {}): SkillTrajectory => ({
	trajectoryId: "traj-1",
	agentId: "agent-1",
	startTime: 0,
	...over,
});

describe("parseJsonObject", () => {
	it("parses a JSON object", () => {
		expect(parseJsonObject('{"a":1,"b":"x"}')).toEqual({ a: 1, b: "x" });
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseJsonObject('  \n\t{"a":1}\n  ')).toEqual({ a: 1 });
	});

	it("returns null for empty or whitespace-only input", () => {
		for (const raw of ["", "   ", "\n\t"]) {
			expect(parseJsonObject(raw)).toBeNull();
		}
	});

	it("returns null for malformed JSON instead of throwing", () => {
		for (const raw of ["{", "{a:1}", "not json", '{"a":}', "{'a':1}"]) {
			expect(() => parseJsonObject(raw)).not.toThrow();
			expect(parseJsonObject(raw)).toBeNull();
		}
	});

	it("returns null for valid JSON that is not an object", () => {
		for (const raw of ["null", "123", '"text"', "true", "false"]) {
			expect(parseJsonObject(raw)).toBeNull();
		}
	});

	it("preserves nested structure without flattening", () => {
		expect(parseJsonObject('{"outer":{"inner":[1,2,{"deep":true}]}}')).toEqual({
			outer: { inner: [1, 2, { deep: true }] },
		});
	});
});

describe("getTrajectoryService", () => {
	it("returns null when no service is registered", () => {
		expect(getTrajectoryService(runtimeWith(null))).toBeNull();
		expect(getTrajectoryService(runtimeWith(undefined))).toBeNull();
	});

	it("returns null unless BOTH methods are present", () => {
		expect(getTrajectoryService(runtimeWith({}))).toBeNull();
		expect(
			getTrajectoryService(runtimeWith({ listTrajectories: () => undefined })),
		).toBeNull();
		expect(
			getTrajectoryService(
				runtimeWith({ getTrajectoryDetail: () => undefined }),
			),
		).toBeNull();
	});

	it("returns null when a method is present but not callable", () => {
		expect(
			getTrajectoryService(
				runtimeWith({
					listTrajectories: "nope",
					getTrajectoryDetail: () => undefined,
				}),
			),
		).toBeNull();
	});

	it("returns the service when both methods are functions", () => {
		const service = {
			listTrajectories: () => undefined,
			getTrajectoryDetail: () => undefined,
		};
		expect(getTrajectoryService(runtimeWith(service))).toBe(service);
	});
});

describe("formatTrajectoryForPrompt — header", () => {
	it("names the trajectory and reports unknown status by default", () => {
		expect(formatTrajectoryForPrompt(trajectory())).toBe(
			"Trajectory: traj-1\nStatus: unknown",
		);
	});

	it("uses the final status when present", () => {
		expect(
			formatTrajectoryForPrompt(
				trajectory({ metrics: { finalStatus: "completed" } }),
			),
		).toContain("Status: completed");
	});

	it("honours a custom status label", () => {
		expect(
			formatTrajectoryForPrompt(trajectory(), { statusLabel: "Outcome" }),
		).toContain("Outcome: unknown");
	});

	it("adds the step count only when asked", () => {
		const steps = [{ timestamp: 1 }, { timestamp: 2 }];
		expect(
			formatTrajectoryForPrompt(trajectory({ steps }), {
				includeStepCount: true,
			}),
		).toContain("Step count: 2");
		expect(formatTrajectoryForPrompt(trajectory({ steps }))).not.toContain(
			"Step count",
		);
	});

	it("adds a blank line after the header only when asked", () => {
		const withBlank = formatTrajectoryForPrompt(trajectory(), {
			blankLineAfterHeader: true,
		});
		expect(withBlank.split("\n")[2]).toBe("");
		expect(formatTrajectoryForPrompt(trajectory()).split("\n").length).toBe(2);
	});
});

describe("formatTrajectoryForPrompt — steps", () => {
	it("numbers steps from one", () => {
		const out = formatTrajectoryForPrompt(
			trajectory({
				steps: [{ timestamp: 1 }, { timestamp: 2 }, { timestamp: 3 }],
			}),
		);
		expect(out).toContain("--- Step 1 ---");
		expect(out).toContain("--- Step 3 ---");
		expect(out).not.toContain("--- Step 0 ---");
		expect(out).not.toContain("--- Step 4 ---");
	});

	it("labels a call by purpose, falling back to actionType then 'step'", () => {
		const out = formatTrajectoryForPrompt(
			trajectory({
				steps: [
					{
						timestamp: 1,
						llmCalls: [
							{ purpose: "plan", actionType: "REPLY" },
							{ actionType: "REPLY" },
							{},
						],
					},
				],
			}),
		);
		expect(out).toContain("[plan]");
		expect(out).toContain("[REPLY]");
		expect(out).toContain("[step]");
	});

	it("renders user and agent turns with their prefixes", () => {
		const out = formatTrajectoryForPrompt(
			trajectory({
				steps: [
					{ timestamp: 1, llmCalls: [{ userPrompt: "hello", response: "hi" }] },
				],
			}),
		);
		expect(out).toContain("USER: hello");
		expect(out).toContain("AGENT: hi");
	});

	it("omits absent turns rather than emitting empty ones", () => {
		const out = formatTrajectoryForPrompt(
			trajectory({
				steps: [{ timestamp: 1, llmCalls: [{ userPrompt: "only" }] }],
			}),
		);
		expect(out).toContain("USER: only");
		expect(out).not.toContain("AGENT:");
	});

	it("handles a step with no calls and a trajectory with no steps", () => {
		expect(() =>
			formatTrajectoryForPrompt(trajectory({ steps: [{ timestamp: 1 }] })),
		).not.toThrow();
		expect(formatTrajectoryForPrompt(trajectory({ steps: [] }))).toBe(
			"Trajectory: traj-1\nStatus: unknown",
		);
	});
});

describe("formatTrajectoryForPrompt — prompt integrity", () => {
	it("carries a long prompt through complete, with no cap or ellipsis", () => {
		const long = "x".repeat(200_000);
		const out = formatTrajectoryForPrompt(
			trajectory({
				steps: [
					{ timestamp: 1, llmCalls: [{ userPrompt: long, response: long }] },
				],
			}),
		);
		expect(out).toContain(`USER: ${long}`);
		expect(out).toContain(`AGENT: ${long}`);
		expect(out).not.toContain("…");
		expect(out).not.toContain("...");
		expect(out).not.toMatch(/truncat/i);
	});

	it("renders every step of a long trajectory, with no window", () => {
		const steps = Array.from({ length: 500 }, (_, i) => ({
			timestamp: i,
			llmCalls: [{ userPrompt: `u${i}`, response: `a${i}` }],
		}));
		const out = formatTrajectoryForPrompt(trajectory({ steps }));
		expect(out).toContain("--- Step 1 ---");
		expect(out).toContain("--- Step 250 ---");
		expect(out).toContain("--- Step 500 ---");
		expect(out).toContain("USER: u499");
		expect((out.match(/--- Step \d+ ---/g) ?? []).length).toBe(500);
	});

	it("renders every call within a step", () => {
		const llmCalls = Array.from({ length: 120 }, (_, i) => ({
			purpose: `p${i}`,
			userPrompt: `u${i}`,
		}));
		const out = formatTrajectoryForPrompt(
			trajectory({ steps: [{ timestamp: 1, llmCalls }] }),
		);
		for (const i of [0, 59, 119]) {
			expect(out).toContain(`[p${i}]`);
			expect(out).toContain(`USER: u${i}`);
		}
	});

	it("repairs lone surrogates without dropping surrounding text", () => {
		const out = formatTrajectoryForPrompt(
			trajectory({
				steps: [
					{
						timestamp: 1,
						llmCalls: [
							{ userPrompt: "before\uD800after", response: "ok\uDC00" },
						],
					},
				],
			}),
		);
		expect(out).toContain("before");
		expect(out).toContain("after");
		expect(out).toContain("ok");
		expect(out.split("\n").some((line) => line.startsWith("USER: "))).toBe(
			true,
		);
	});

	it("preserves an emoji surrogate pair intact", () => {
		const out = formatTrajectoryForPrompt(
			trajectory({
				steps: [{ timestamp: 1, llmCalls: [{ userPrompt: "done 🚀" }] }],
			}),
		);
		expect(out).toContain("done 🚀");
	});

	it("is deterministic for identical input", () => {
		const build = () =>
			trajectory({
				steps: [
					{ timestamp: 1, llmCalls: [{ userPrompt: "a", response: "b" }] },
				],
			});
		expect(formatTrajectoryForPrompt(build())).toBe(
			formatTrajectoryForPrompt(build()),
		);
	});
});
