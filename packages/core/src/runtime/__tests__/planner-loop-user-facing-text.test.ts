import { describe, expect, it, vi } from "vitest";
import {
	looksLikeSpawnEnvelopeJson,
	runPlannerLoop,
	singleVerifiedUserFacingToolResultText,
} from "../planner-loop";
import type { PlannerTrajectory } from "../planner-types";
import type { TrajectoryRecorder } from "../trajectory-recorder";

/**
 * Regression coverage for the structural fix that stops tool-diagnostic
 * `text` (shell prompts, `[exit 0]`, `--- stdout ---` wrappers, cwd
 * markers, byte counts) from being shown to users verbatim.
 *
 * Before this PR, `latestToolResultText` returned `step.result.text` —
 * the tool's log-shaped projection. Tools like BASH emit:
 *
 *   $ find /home/eliza/.eliza/trajectories -type f
 *   [exit 0] (cwd=/home/eliza/iqlabs/eliza/eliza, took=37ms)
 *   --- stdout ---
 *   443
 *
 * That entire wrapper string was leaking into Discord replies because
 * the planner-loop's terminal-FINISH fallback chain used it when the
 * evaluator didn't supply a `messageToUser`.
 *
 * The fix is structural: `PlannerToolResult` now carries an explicit
 * `userFacingText` field. The framework only uses that for direct user
 * display. Tools that emit logs leave it undefined → the framework
 * falls through to a synthesized response message instead of leaking
 * the wrapper. This avoids regex-based wrapper detection and gives
 * every tool a clear contract.
 */

describe("planner-loop — user-facing tool text isolation", () => {
	it("does not leak tool-diagnostic text into the user reply when userFacingText is unset", async () => {
		// Mimic the BASH wrapper that was leaking. A tool that emits a
		// shell log and *no* userFacingText must NOT have its log become
		// the user-facing reply.
		const bashWrapper =
			"$ find /tmp -type f\n[exit 0] (cwd=/home/eliza, took=12ms)\n--- stdout ---\n443";
		const runtime = {
			useModel: vi
				.fn()
				// First call: planner — emits one tool call, no messageToUser.
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "call-1", name: "BASH", arguments: {} }],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				// Second call: evaluator — decides FINISH, no messageToUser.
				.mockResolvedValueOnce({
					text: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Tool finished cleanly.",
						// No messageToUser — this is the failure mode that used to
						// trigger the leak.
					}),
					usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			// Tool's diagnostic log goes into `text` — must NEVER reach user.
			text: bashWrapper,
			// `userFacingText` deliberately omitted — BASH is a log-only tool.
		}));
		const recorder: TrajectoryRecorder = {
			startTrajectory: vi.fn(() => "trj-1"),
			recordStage: vi.fn(async () => undefined),
			endTrajectory: vi.fn(async () => undefined),
			load: vi.fn(async () => null),
			list: vi.fn(async () => []),
		};
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
			recorder,
			trajectoryId: "trj-1",
		});

		expect(result.status).toBe("finished");
		// The final message must not contain any portion of the shell
		// wrapper. Specifically: no `$ `, no `[exit `, no `--- stdout ---`,
		// no `cwd=`. (These are properties of the wrapper, not regex used
		// to fix it — the fix itself is the userFacingText opt-in. These
		// assertions just prove the leak is gone.)
		const finalMessage = result.finalMessage ?? "";
		expect(finalMessage).not.toContain("$ find");
		expect(finalMessage).not.toContain("[exit");
		expect(finalMessage).not.toContain("--- stdout ---");
		expect(finalMessage).not.toContain("cwd=");
	});

	it("uses userFacingText as the reply when a tool sets it", async () => {
		const userFriendly =
			"Here are your 3 most recent PRs: #7593, #7592, #7588.";
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "call-1", name: "Q_AND_A", arguments: {} }],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				// Evaluator: FINISH with no messageToUser → framework falls
				// through to latestToolResultText, which now returns
				// userFacingText.
				.mockResolvedValueOnce({
					text: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Tool answered.",
					}),
					usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: `Q_AND_A result\n[exit 0]\n--- stdout ---\n${userFriendly}`,
			userFacingText: userFriendly,
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe(userFriendly);
		// Diagnostic wrapper still must not leak.
		expect(result.finalMessage ?? "").not.toContain("[exit 0]");
	});

	it("does not regress evaluator's explicit messageToUser path", async () => {
		// When evaluator provides a clean messageToUser, the tool's
		// userFacingText is not even consulted — the evaluator wins.
		const evaluatorMessage = "All three counters reset to zero.";
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "call-1", name: "ANY", arguments: {} }],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				.mockResolvedValueOnce({
					text: JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "Tool finished.",
						messageToUser: evaluatorMessage,
					}),
					usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
				}),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "internal log",
			userFacingText: "tool would also have something to say",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			messageToUser: evaluatorMessage,
			thought: "Done.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe(evaluatorMessage);
	});
});

describe("singleVerifiedUserFacingToolResultText — failed-step filter", () => {
	// Greptile flagged that the previous implementation counted ALL steps
	// with `toolCall + result` toward its uniqueness check — failed steps
	// included — so a 2-tool plan whose first tool errored and whose
	// second tool set `verifiedUserFacing: true` would silently fall
	// through to the evaluator's reply. These tests pin the corrected
	// filter (`step.result?.success === true`).
	const trajectoryWith = (
		steps: PlannerTrajectory["steps"],
	): PlannerTrajectory => ({
		context: { id: "ctx" },
		steps,
		archivedSteps: [],
		plannedQueue: [],
		evaluatorOutputs: [],
	});

	const failedStep = {
		iteration: 0,
		toolCall: { id: "call-1", name: "FLAKY", arguments: {} },
		result: {
			success: false as const,
			text: "transient network error",
			error: "ECONNRESET",
		},
	};
	const verifiedStep = {
		iteration: 1,
		toolCall: { id: "call-2", name: "CHECK_CACHE", arguments: {} },
		result: {
			success: true as const,
			text: "raw diag",
			userFacingText: "Wrote 14 files to /home/example/.bun/install/cache.",
			verifiedUserFacing: true,
		},
	};

	it("returns the verified tool's text when a prior step failed", () => {
		const trajectory = trajectoryWith([failedStep, verifiedStep]);
		expect(singleVerifiedUserFacingToolResultText(trajectory)).toBe(
			"Wrote 14 files to /home/example/.bun/install/cache.",
		);
	});

	it("returns undefined when two successful tools both have results", () => {
		// Genuine ambiguity — caller falls through to evaluator/fallback.
		const secondVerified = {
			...verifiedStep,
			iteration: 2,
			toolCall: { id: "call-3", name: "OTHER", arguments: {} },
		};
		const trajectory = trajectoryWith([
			{ ...verifiedStep, iteration: 1 },
			secondVerified,
		]);
		expect(singleVerifiedUserFacingToolResultText(trajectory)).toBeUndefined();
	});

	it("returns undefined when the single successful tool did not opt in", () => {
		const trajectory = trajectoryWith([
			failedStep,
			{
				...verifiedStep,
				result: { ...verifiedStep.result, verifiedUserFacing: false },
			},
		]);
		expect(singleVerifiedUserFacingToolResultText(trajectory)).toBeUndefined();
	});

	it("returns undefined when there are no successful tools", () => {
		const trajectory = trajectoryWith([failedStep]);
		expect(singleVerifiedUserFacingToolResultText(trajectory)).toBeUndefined();
	});
});

// A weak planner (gpt-oss-class) sometimes hallucinates its own TASKS spawn-arg
// object into messageToUser, leaking {"task":…,"agentType":"opencode",…} to the
// user instead of spawning + narrating the sub-agent's real result (battery #3).
// userSafeFinalMessage suppresses it via this structural shape detector.
describe("looksLikeSpawnEnvelopeJson — spawn-arg leak detector", () => {
	it("flags a leaked TASKS spawn-arg JSON object", () => {
		expect(
			looksLikeSpawnEnvelopeJson(
				'{"task":"Fetch the current Bitcoin price","agentType":"opencode","approvalPreset":"standard","brief":"webfetch coingecko"}',
			),
		).toBe(true);
	});

	it("flags the same envelope wrapped in a ```json fence", () => {
		expect(
			looksLikeSpawnEnvelopeJson(
				'```json\n{"task":"x","agentType":"codex","brief":"y"}\n```',
			),
		).toBe(true);
	});

	it("does NOT flag a real prose answer", () => {
		expect(
			looksLikeSpawnEnvelopeJson("The current price of bitcoin is $68,000."),
		).toBe(false);
	});

	it("does NOT flag a genuine JSON answer with non-spawn keys", () => {
		expect(
			looksLikeSpawnEnvelopeJson('{"favoriteColor":"teal","mood":"calm"}'),
		).toBe(false);
	});

	it("does NOT flag an object with only one spawn discriminator", () => {
		expect(looksLikeSpawnEnvelopeJson('{"task":"do a thing"}')).toBe(false);
	});

	it("does NOT flag non-object / unparseable text", () => {
		expect(looksLikeSpawnEnvelopeJson("[1,2,3]")).toBe(false);
		expect(looksLikeSpawnEnvelopeJson('{"task": broken')).toBe(false);
		expect(looksLikeSpawnEnvelopeJson("")).toBe(false);
	});
});
