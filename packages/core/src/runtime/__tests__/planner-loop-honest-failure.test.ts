/**
 * Honest failed-turn replies (#17948): a planner turn that ends on a failed
 * step must ship a model-authored reply naming what failed and why — never
 * the fixed "runtime step failed" sentence — across every failure shape: exec
 * failures, thrown timeouts, validation rejects, structural retryable:false
 * results, and multi-step turns that fail late. Also pins the hygiene of the
 * prompt context the loop adds (scrubbed causes, no absolute paths or ids)
 * and the J4 degrade when the synthesis model call itself fails.
 * Deterministic — `useModel`, `executeToolCall`, and `evaluate` are vitest
 * mocks; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import {
	FAILED_TOOL_FALLBACK_MESSAGE,
	HANDLED_STEP_FALLBACK_MESSAGE,
	runPlannerLoop,
} from "../planner-loop";

type MockedMessages = {
	messages?: Array<{ role?: string; content?: unknown }>;
};

/** The instruction blocks the loop itself composes (retry / synthesis) — the
 * surface whose hygiene #17948 governs, as opposed to raw tool-result
 * messages that already existed in the trajectory rendering. */
function loopComposedInstructionText(
	useModel: ReturnType<typeof vi.fn>,
	callIndex: number,
	marker: string,
): string {
	const params = useModel.mock.calls[callIndex]?.[1] as
		| MockedMessages
		| undefined;
	return (params?.messages ?? [])
		.map((message) =>
			typeof message.content === "string" ? message.content : "",
		)
		.filter((content) => content.includes(marker))
		.join("\n");
}

describe("honest failed-turn replies (#17948)", () => {
	it("exec failure then REPLY: ships a failure-aware synthesis primed with the scrubbed cause, not the canned sentence", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "SHELL",
						arguments: { command: 'git log --since="1 week ago" --oneline' },
					},
				],
			})
			// Replan after the silent failed FINISH: the model recovers with a
			// terminal REPLY. The tool-owned failure stays authoritative, so the
			// loop answers through the failure-aware synthesis pass instead.
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "REPLY",
						arguments: { text: "I hit an error while checking the log." },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "I tried to check this week's git log, but this workspace repo has no commits yet.",
				toolCalls: [],
			});
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: "command_failed: exit 128 in /home/milady/workspace/repo: fatal: your current branch 'master' does not have any commits yet",
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "FINISH" as const,
			thought: "The step failed.",
		}));

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "SHELL", description: "Run a shell command." }],
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledTimes(3);
		expect(result.finalMessage).toBe(
			"I tried to check this week's git log, but this workspace repo has no commits yet.",
		);
		expect(result.finalMessage).not.toBe(FAILED_TOOL_FALLBACK_MESSAGE);

		// The silent-failed-finish retry instruction names the failed tool AND
		// its human-readable cause, with internal detail scrubbed.
		const retryInstruction = loopComposedInstructionText(
			useModel,
			1,
			"silent_failed_finish",
		);
		expect(retryInstruction).toContain("failed_tool: SHELL");
		expect(retryInstruction).toContain("failed_tool_cause:");
		expect(retryInstruction).toContain("does not have any commits yet");
		expect(retryInstruction).toContain("<path>");
		expect(retryInstruction).not.toContain("/home/milady");

		// The failure synthesis prompt receives the failed step and cause the
		// same way — scrubbed, human-shaped, no absolute paths.
		const synthesisInstruction = loopComposedInstructionText(
			useModel,
			2,
			"Recorded failure cause",
		);
		expect(synthesisInstruction).toContain("The SHELL step failed");
		expect(synthesisInstruction).toContain("does not have any commits yet");
		expect(synthesisInstruction).toContain("<path>");
		expect(synthesisInstruction).not.toContain("/home/milady");
	});

	it("thrown timeout: the evaluator's success:false diagnosis ships directly with no extra model call", async () => {
		const useModel = vi.fn().mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "call-1",
					name: "WEB_FETCH",
					arguments: { url: "https://example.com/report" },
				},
			],
		});
		const executeToolCall = vi.fn(async () => {
			throw new Error("WEB_FETCH timed out after 30000ms");
		});
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "FINISH" as const,
			thought: "The fetch timed out.",
			messageToUser:
				"I tried to fetch that page, but the request timed out before anything came back.",
		}));

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "WEB_FETCH", description: "Fetch a URL." }],
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(result.finalMessage).toBe(
			"I tried to fetch that page, but the request timed out before anything came back.",
		);
	});

	it("validation reject: the producer's human text reaches the retry context and the evaluator's diagnosis ships from the terminal-text path", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "SCHEDULED_TASKS",
						arguments: { action: "create", task: "water the plants" },
					},
				],
			})
			// Replan ends in terminal planner text, exercising the terminal-text
			// FINISH path's failure acknowledgment.
			.mockResolvedValueOnce({
				text: "I couldn't set that up without a schedule trigger.",
				toolCalls: [],
			});
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: "I need a trigger (once, cron, or every) before I can schedule that.",
			data: { error: "MISSING_TRIGGER" },
		}));
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "Validation failed and I have no reply.",
			})
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "Cannot schedule without a trigger.",
				messageToUser:
					"I couldn't schedule that — I still need to know when it should run (once, on a cron, or repeating).",
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "SCHEDULED_TASKS", description: "Manage schedules." }],
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		const retryInstruction = loopComposedInstructionText(
			useModel,
			1,
			"silent_failed_finish",
		);
		expect(retryInstruction).toContain(
			"failed_tool_cause: I need a trigger (once, cron, or every)",
		);
		expect(result.finalMessage).toBe(
			"I couldn't schedule that — I still need to know when it should run (once, on a cron, or repeating).",
		);
	});

	it("retryable:false structured failure: the synthesis pass receives the structural failure's human text", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "DEPLOY_APP",
						arguments: { template: "landing-page" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "Deployment failed.",
				toolCalls: [],
			})
			.mockResolvedValueOnce({
				text: "I couldn't deploy the app — the template needs a name and I didn't have one to give it.",
				toolCalls: [],
			});
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: "The app build failed: the template requires a name and none was provided.",
			data: { retryable: false },
		}));
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "Build failed silently.",
			})
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "Nothing more to do.",
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "DEPLOY_APP", description: "Deploy an app." }],
			executeToolCall,
			evaluate,
		});

		// The structural non-retryable failure was never blindly re-executed and
		// the reply is the model's own synthesis, primed with the failure text.
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledTimes(3);
		const synthesisInstruction = loopComposedInstructionText(
			useModel,
			2,
			"Recorded failure cause",
		);
		expect(synthesisInstruction).toContain("The DEPLOY_APP step failed");
		expect(synthesisInstruction).toContain("requires a name");
		expect(result.finalMessage).toBe(
			"I couldn't deploy the app — the template needs a name and I didn't have one to give it.",
		);
	});

	it("multi-step turn: a late failure after earlier successes ships the evaluator's diagnosis, not the canned sentence", async () => {
		const useModel = vi.fn().mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "call-1",
					name: "VIEWS",
					arguments: { action: "list" },
				},
				{
					id: "call-2",
					name: "SHELL",
					arguments: { command: "grep -r missing-pattern ." },
				},
			],
		});
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({ success: true, text: "3 views listed" })
			.mockResolvedValueOnce({
				success: false,
				text: "command_failed: exit 1: grep found no matches",
			});
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "NEXT_RECOMMENDED" as const,
				thought: "Run the queued search next.",
				recommendedToolCallId: "call-2",
			})
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "The search failed after the listing succeeded.",
				messageToUser:
					"I pulled the view list, but the follow-up search failed — nothing matched that pattern.",
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [
				{ name: "VIEWS", description: "List views." },
				{ name: "SHELL", description: "Run a shell command." },
			],
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).toHaveBeenCalledTimes(2);
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(result.finalMessage).toBe(
			"I pulled the view list, but the follow-up search failed — nothing matched that pattern.",
		);
	});

	it("rejects an unsafe evaluator diagnosis and rescues the turn through the synthesis pass", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "SHELL",
						arguments: { command: "ls" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "I couldn't read that directory — the command failed with a permissions error.",
				toolCalls: [],
			});
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: "command_failed: permission denied",
		}));
		// A diagnosis that leaks tool-invocation syntax must not ship even
		// though the evaluator structurally acknowledged the failure.
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "FINISH" as const,
			thought: "Failed.",
			messageToUser: "We need to call SHELL again with sudo parameters.",
		}));

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "SHELL", description: "Run a shell command." }],
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe(
			"I couldn't read that directory — the command failed with a permissions error.",
		);
	});

	it("scrubs uuids, hex ids, and absolute paths from the failure cause it adds to prompt context", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "SHELL",
						arguments: { command: "git fetch" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "The fetch step failed on a missing workspace reference.",
				toolCalls: [],
			});
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: "command_failed: workspace 3f2504e0-4f89-11d3-9a0c-0305e82c3301 at /var/lib/agent/workspaces/repo missing ref deadbeefdeadbeefdeadbeef",
		}));
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "Failed with no reply.",
			})
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "Cannot fetch.",
				messageToUser:
					"I couldn't fetch that — the workspace reference it needs is missing.",
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "SHELL", description: "Run a shell command." }],
			executeToolCall,
			evaluate,
		});

		const retryInstruction = loopComposedInstructionText(
			useModel,
			1,
			"failed_tool_cause",
		);
		expect(retryInstruction).toContain("<id>");
		expect(retryInstruction).toContain("<path>");
		expect(retryInstruction).not.toContain(
			"3f2504e0-4f89-11d3-9a0c-0305e82c3301",
		);
		expect(retryInstruction).not.toContain("/var/lib");
		expect(retryInstruction).not.toContain("deadbeef");
		expect(result.finalMessage).toBe(
			"I couldn't fetch that — the workspace reference it needs is missing.",
		);
	});

	it("keeps the generic failed-step sentence only when the synthesis model call itself fails", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "SHELL",
						arguments: { command: "ls" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "REPLY",
						arguments: { text: "Something went wrong." },
					},
				],
			})
			.mockRejectedValueOnce(new Error("provider unavailable"));
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: "command_failed: disk io error",
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "FINISH" as const,
			thought: "Failed.",
		}));

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "SHELL", description: "Run a shell command." }],
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(3);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
	});
});

describe("rescue synthesis from successful tool results (2026-08-11 sub-agent report failures)", () => {
	it("blank failure-synthesis falls back to a TEXT_LARGE rescue composed from successful results", async () => {
		const useModel = vi
			.fn()
			// 1: planner runs the research tool (succeeds).
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "WEB_SEARCH",
						arguments: { query: "standujar contributions elizaOS" },
					},
				],
			})
			// 2: planner runs a second step (fails).
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "SHELL",
						arguments: { command: "gh pr list" },
					},
				],
			})
			// 3: silent-failed-finish retry — the model recovers with a REPLY,
			// but the tool-owned failure stays authoritative.
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-3",
						name: "REPLY",
						arguments: { text: "hit a snag." },
					},
				],
			})
			// 4: failure-aware synthesis returns BLANK (the reasoning-burn shape
			// observed live: completion budget consumed, zero visible text).
			.mockResolvedValueOnce({ text: "", toolCalls: [] })
			// 5: the TEXT_LARGE rescue call composes from the successful results.
			.mockResolvedValueOnce(
				"standujar reviewed 85 pull requests over the last four days and filed 46 issues.",
			);
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				text: "search results: standujar reviewed 85 pull requests, filed 46 issues",
			})
			.mockResolvedValueOnce({
				success: false,
				text: "command_failed: exit 3",
			});
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				decision: "CONTINUE" as const,
				thought: "Got the research, need the PR list.",
			})
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "The step failed.",
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [
				{ name: "WEB_SEARCH", description: "Search the web." },
				{ name: "SHELL", description: "Run a shell command." },
			],
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe(
			"standujar reviewed 85 pull requests over the last four days and filed 46 issues.",
		);
		expect(result.finalMessage).not.toBe(FAILED_TOOL_FALLBACK_MESSAGE);
		// The rescue call carried the successful result as input material
		// (native chat `messages`, the only shape PlannerRuntime.useModel
		// accepts), fenced as untrusted tool output.
		const rescueParams = useModel.mock.calls[4]?.[1] as
			| MockedMessages
			| undefined;
		const rescueText = (rescueParams?.messages ?? [])
			.map((message) =>
				typeof message.content === "string" ? message.content : "",
			)
			.join("\n");
		expect(rescueText).toContain('<tool_result name="WEB_SEARCH">');
		expect(rescueText).toContain("85 pull requests");
	});

	it("keeps the generic sentence when there are no successful results to rescue from", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "SHELL",
						arguments: { command: "false" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-2", name: "REPLY", arguments: { text: "hm." } },
				],
			})
			// Failure synthesis blank; NO rescue call should follow (nothing to
			// rescue from), so no fifth mock is provided.
			.mockResolvedValueOnce({ text: "", toolCalls: [] });
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: "command_failed: exit 1",
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "FINISH" as const,
			thought: "The step failed.",
		}));

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "SHELL", description: "Run a shell command." }],
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(3);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
	});

	it("rescues complete prior successes without discarding their evidence", async () => {
		const runtimeSecret = "SYNTH-RESCUE-RUNTIME-SECRET-1111";
		const flagCanary = "SYNTH-RESCUE-FLAG-CANARY-2222";
		const searchResultA =
			`search results A: archived-fact-alpha --token=${flagCanary} ${runtimeSecret} — the fleet release shipped with twelve plugins. ` +
			"padding ".repeat(400);
		const searchResultB =
			"search results B: archived-fact-beta — the shipwright tail closed out last week. " +
			"padding ".repeat(400);
		const useModel = vi
			.fn()
			// 1-2: two research steps succeed; both remain in the planner trajectory
			// moves both into archivedSteps before the turn ends.
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "WEB_SEARCH",
						arguments: { query: "fleet release plugins" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "WEB_SEARCH",
						arguments: { query: "shipwright tail status" },
					},
				],
			})
			// 3: the follow-up step fails.
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-3",
						name: "SHELL",
						arguments: { command: "gh pr list" },
					},
				],
			})
			// 4: silent-failed-finish retry recovers with a REPLY; the tool-owned
			// failure stays authoritative.
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-4", name: "REPLY", arguments: { text: "hit a snag." } },
				],
			})
			// 5: failure-aware synthesis returns blank.
			.mockResolvedValueOnce({ text: "", toolCalls: [] })
			// 6: the TEXT_LARGE rescue composes from the complete successes.
			.mockResolvedValueOnce(
				"The fleet release shipped with twelve plugins and the shipwright tail closed out, though the PR listing step failed.",
			);
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({ success: true, text: searchResultA })
			.mockResolvedValueOnce({ success: true, text: searchResultB })
			.mockResolvedValueOnce({
				success: false,
				text: "command_failed: exit 3",
			});
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				decision: "CONTINUE" as const,
				thought: "More research needed.",
			})
			.mockResolvedValueOnce({
				success: true,
				decision: "CONTINUE" as const,
				thought: "Now list the PRs.",
			})
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "The step failed.",
			});

		const result = await runPlannerLoop({
			runtime: {
				useModel,
				redactSecrets: (text: string) =>
					text.split(runtimeSecret).join("[REDACTED:RESCUE]"),
			},
			context: { id: "ctx" },
			tools: [
				{ name: "WEB_SEARCH", description: "Search the web." },
				{ name: "SHELL", description: "Run a shell command." },
			],
			executeToolCall,
			evaluate,
		});

		// Both successes remain available verbatim to the rescue.
		expect(
			result.trajectory.steps.filter((step) => step.result?.success === true)
				.length,
		).toBeGreaterThanOrEqual(2);
		expect(
			result.trajectory.steps.some(
				(step) =>
					step.toolCall?.name === "WEB_SEARCH" && step.result?.success === true,
			),
		).toBe(true);
		// The rescue still surfaced them instead of no-opping into the canned
		// failure sentence.
		expect(result.finalMessage).toBe(
			"The fleet release shipped with twelve plugins and the shipwright tail closed out, though the PR listing step failed.",
		);
		const rescueParams = useModel.mock.calls[5]?.[1] as
			| MockedMessages
			| undefined;
		const rescueText = (rescueParams?.messages ?? [])
			.map((message) =>
				typeof message.content === "string" ? message.content : "",
			)
			.join("\n");
		expect(rescueText).toContain("archived-fact-alpha");
		expect(rescueText).toContain("archived-fact-beta");
		expect(rescueText).not.toContain(runtimeSecret);
		expect(rescueText).not.toContain(flagCanary);
	});

	it("never ships the handled-step placeholder as a rescue: a canned synthesis falls through to the honest failure", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "WEB_SEARCH",
						arguments: { query: "release notes" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "SHELL",
						arguments: { command: "gh pr list" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-3", name: "REPLY", arguments: { text: "hit a snag." } },
				],
			})
			// Failure-aware synthesis blank, then the rescue model parrots the
			// canned placeholder instead of composing a real answer.
			.mockResolvedValueOnce({ text: "", toolCalls: [] })
			.mockResolvedValueOnce(HANDLED_STEP_FALLBACK_MESSAGE);
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				text: "search results: the release notes list forty-two changes",
			})
			.mockResolvedValueOnce({
				success: false,
				text: "command_failed: exit 3",
			});
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				decision: "CONTINUE" as const,
				thought: "Now list the PRs.",
			})
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "The step failed.",
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [
				{ name: "WEB_SEARCH", description: "Search the web." },
				{ name: "SHELL", description: "Run a shell command." },
			],
			executeToolCall,
			evaluate,
		});

		// A canned non-answer must not ship as a successful rescue; the caller
		// keeps its honest failure reply instead.
		expect(result.finalMessage).not.toBe(HANDLED_STEP_FALLBACK_MESSAGE);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
	});

	it("frames the rescued reply as a partial failure: the compose prompt names the failed step with a scrubbed cause", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "WEB_SEARCH",
						arguments: { query: "quarterly numbers" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "SHELL",
						arguments: { command: "gh pr list" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-3", name: "REPLY", arguments: { text: "hit a snag." } },
				],
			})
			.mockResolvedValueOnce({ text: "", toolCalls: [] })
			.mockResolvedValueOnce(
				"Revenue grew nine percent last quarter, though the PR listing part of this did not complete.",
			);
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				text: "search results: revenue grew nine percent last quarter",
			})
			.mockResolvedValueOnce({
				success: false,
				text: "command_failed: exit 128 in /home/milady/workspace/repo: gh not authenticated",
			});
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				decision: "CONTINUE" as const,
				thought: "Now list the PRs.",
			})
			.mockResolvedValueOnce({
				success: false,
				decision: "FINISH" as const,
				thought: "The step failed.",
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [
				{ name: "WEB_SEARCH", description: "Search the web." },
				{ name: "SHELL", description: "Run a shell command." },
			],
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe(
			"Revenue grew nine percent last quarter, though the PR listing part of this did not complete.",
		);
		// The compose prompt is honest about the partial failure — it names the
		// failed step and carries the scrubbed cause — instead of presenting
		// only the successful excerpts as a clean turn.
		const rescueParams = useModel.mock.calls[4]?.[1] as
			| MockedMessages
			| undefined;
		const rescueText = (rescueParams?.messages ?? [])
			.map((message) =>
				typeof message.content === "string" ? message.content : "",
			)
			.join("\n");
		expect(rescueText).toContain("SHELL step did not complete");
		expect(rescueText).toContain("<path>");
		expect(rescueText).not.toContain("/home/milady");
		expect(rescueText).toContain("untrusted");
		// The failed step stays recorded in the trajectory — the turn is not
		// relabeled a clean success.
		expect(
			[...result.trajectory.archivedSteps, ...result.trajectory.steps].some(
				(step) => step.result?.success === false,
			),
		).toBe(true);
	});

	it("preserves every successful result when more than six are available", async () => {
		const searchCount = 7;
		const plannerResponses: Array<unknown> = [
			...Array.from({ length: searchCount }, (_, index) => ({
				text: "",
				toolCalls: [
					{
						id: `call-${index + 1}`,
						name: "WEB_SEARCH",
						arguments: { query: `q0${index + 1}` },
					},
				],
			})),
			{
				text: "",
				toolCalls: [
					{
						id: `call-${searchCount + 1}`,
						name: "SHELL",
						arguments: { command: "gh pr list" },
					},
				],
			},
			{
				text: "",
				toolCalls: [
					{
						id: `call-${searchCount + 2}`,
						name: "REPLY",
						arguments: { text: "hit a snag." },
					},
				],
			},
			// Failure-aware synthesis blank, then the rescue composes the reply.
			{ text: "", toolCalls: [] },
			"The latest refinements settled it: the final numbers are in, though the last step failed.",
		];
		const useModel = vi.fn(async () => {
			const next = plannerResponses.shift();
			if (next === undefined) {
				throw new Error("unexpected extra model call");
			}
			return next;
		});
		const executeToolCall = vi.fn(
			async (toolCall: { name: string; params?: Record<string, unknown> }) =>
				toolCall.name === "WEB_SEARCH"
					? {
							success: true,
							text: `search results: unique-fact-${String(toolCall.params?.query)}`,
						}
					: { success: false, text: "command_failed: exit 3" },
		);
		const evaluate = vi.fn();
		for (let index = 0; index < searchCount; index++) {
			evaluate.mockResolvedValueOnce({
				success: true,
				decision: "CONTINUE" as const,
				thought: `Refinement ${index + 1} captured.`,
			});
		}
		evaluate.mockResolvedValueOnce({
			success: false,
			decision: "FINISH" as const,
			thought: "The step failed.",
		});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [
				{ name: "WEB_SEARCH", description: "Search the web." },
				{ name: "SHELL", description: "Run a shell command." },
			],
			executeToolCall,
			evaluate,
		});

		expect(result.finalMessage).toBe(
			"The latest refinements settled it: the final numbers are in, though the last step failed.",
		);
		// Every successful result remains available to the rescue model.
		const rescueParams = useModel.mock.calls[10]?.[1] as
			| MockedMessages
			| undefined;
		const rescueText = (rescueParams?.messages ?? [])
			.map((message) =>
				typeof message.content === "string" ? message.content : "",
			)
			.join("\n");
		expect(rescueText).toContain("unique-fact-q07");
		expect(rescueText).toContain("unique-fact-q02");
		expect(rescueText).toContain("unique-fact-q01");
	});
});
