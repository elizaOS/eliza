/**
 * Honest failed-turn replies (#17948): a planner turn that ends on a failed
 * step keeps the machine-recorded failure authoritative across exec failures,
 * thrown timeouts, validation rejects, structural retryable:false results,
 * and multi-step turns that fail late. Model-authored explanations may enrich
 * structurally acknowledged evaluator failures, but forced synthesis cannot
 * relabel an unresolved operation. The suite also pins prompt hygiene and J4
 * degradation when synthesis fails.
 * Deterministic — `useModel`, `executeToolCall`, and `evaluate` are vitest
 * mocks; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import {
	FAILED_TOOL_FALLBACK_MESSAGE,
	runPlannerLoop,
	TOOL_RESULT_UNAVAILABLE_MESSAGE,
} from "../planner-loop";

type MockedMessages = {
	messages?: Array<{ role?: string; content?: unknown }>;
	responseSchema?: unknown;
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
	it("exec failure then REPLY: records a scrubbed synthesis attempt but keeps machine failure authority", async () => {
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
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);

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

	it("retryable:false structured failure: synthesis receives the cause but cannot replace failure authority", async () => {
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
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
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

	it("rejects an unsafe evaluator diagnosis and keeps machine failure authority after synthesis", async () => {
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
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
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

	it("keeps machine failure authority when the synthesis model call itself fails", async () => {
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

describe("deterministic post-synthesis relay", () => {
	it("emits only machine-owned failure authority despite a contradictory nonblank synthesis", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "WEB_SEARCH",
						arguments: { query: "release readiness" },
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
					{
						id: "call-3",
						name: "REPLY",
						arguments: { text: "Everything is ready to ship." },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "Everything completed successfully and is ready to ship.",
				toolCalls: [],
			});
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				text: "stdout: release candidate built",
				userFacingText: "Everything is ready to ship.",
				verifiedUserFacing: true,
			})
			.mockResolvedValueOnce({
				success: false,
				text: "command_failed: PR listing unavailable",
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
				thought: "The listing failed.",
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: {
				id: "ctx",
				events: [
					{
						id: "current-request",
						type: "message",
						message: {
							role: "user",
							content: { text: "Summarize release readiness and blockers." },
						},
					},
				],
			},
			provider: "pinned-provider",
			tools: [
				{ name: "WEB_SEARCH", description: "Search the web." },
				{ name: "SHELL", description: "Run a shell command." },
			],
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(4);
		expect(
			useModel.mock.calls.every((call) => call[2] === "pinned-provider"),
		).toBe(true);
		const synthesisMessages = (
			useModel.mock.calls[3]?.[1] as MockedMessages | undefined
		)?.messages;
		expect(JSON.stringify(synthesisMessages)).toContain(
			"Summarize release readiness and blockers.",
		);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
		expect(result.finalMessage).not.toMatch(
			/ready to ship|completed successfully/iu,
		);
		expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(
			FAILED_TOOL_FALLBACK_MESSAGE,
		);
	});

	it("does not surface path, id, or credential prose from failure-aware synthesis", async () => {
		const leaked =
			"Everything succeeded for job 3f2504e0-4f89-11d3-9a0c-0305e82c3301 at /private/ops; use API_TOKEN=never-show.";
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "WEB_SEARCH",
						arguments: { query: "release readiness" },
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
					{
						id: "call-3",
						name: "REPLY",
						arguments: { text: "Everything is ready to ship." },
					},
				],
			})
			.mockResolvedValueOnce({ text: leaked, toolCalls: [] });
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({
				success: true,
				text: "stdout: release candidate built",
				userFacingText: "Candidate build completed.",
			})
			.mockResolvedValueOnce({
				success: false,
				text: "command_failed: PR listing unavailable",
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
				thought: "The listing failed.",
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

		expect(useModel).toHaveBeenCalledTimes(4);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
		expect(result.finalMessage).not.toMatch(
			/private\/ops|3f2504e0|API_TOKEN|never-show/iu,
		);
		expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(
			FAILED_TOOL_FALLBACK_MESSAGE,
		);
	});

	it("recovers exact canonical userFacingText without exposing diagnostics", async () => {
		const useModel = vi.fn().mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{ id: "call-1", name: "LOOKUP", arguments: { query: "today" } },
			],
		});
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "stdout:\n/private/ops/raw.log\nAPI_TOKEN=never-show",
			userFacingText: "Found three matching records.",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
			messageToUser: "call:LOOKUP{query:today}",
		}));

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			provider: "pinned-provider",
			tools: [{ name: "LOOKUP", description: "Look up records." }],
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel.mock.calls[0]?.[2]).toBe("pinned-provider");
		expect(result.finalMessage).toBe("Found three matching records.");
		expect(result.finalMessage).not.toMatch(/stdout|private\/ops|API_TOKEN/iu);
	});

	it("fails closed when successful work exposes only raw shell diagnostics", async () => {
		const leaked =
			"Successful results: stdout:\n/private/ops/raw.log\nAWS_SECRET_ACCESS_KEY=never-show\nAuthorization: Bearer secret\njob 3f2504e0-4f89-11d3-9a0c-0305e82c3301";
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-1", name: "SHELL", arguments: { command: "env" } },
				],
			})
			.mockResolvedValueOnce({ text: leaked, toolCalls: [] });
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "stdout:\n/private/ops/raw.log\nAWS_SECRET_ACCESS_KEY=never-show\nAuthorization: Bearer secret\njob 3f2504e0-4f89-11d3-9a0c-0305e82c3301",
			transcriptVisibility: "internal" as const,
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
			messageToUser: "call:SHELL{command:env}",
		}));

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "SHELL", description: "Run a shell command." }],
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		const synthesisParams = useModel.mock.calls[1]?.[1] as MockedMessages;
		const synthesisPayload = (synthesisParams.messages ?? [])
			.filter((message) => message.role === "user")
			.map((message) => String(message.content))
			.join("\n");
		expect(synthesisPayload).toContain("tool_authority");
		expect(synthesisPayload).toContain("machine_status: success");
		expect(synthesisPayload).toContain(
			"canonical_user_facing_text: unavailable",
		);
		expect(synthesisPayload).not.toMatch(
			/stdout|private\/ops|AWS_SECRET_ACCESS_KEY|Authorization|Bearer|3f2504e0/iu,
		);
		expect(useModel.mock.results[1]?.type).toBe("return");
		expect(result.finalMessage).toBe(TOOL_RESULT_UNAVAILABLE_MESSAGE);
		expect(result.finalMessage).not.toMatch(
			/stdout|private\/ops|AWS_SECRET_ACCESS_KEY|Authorization|Bearer|3f2504e0/iu,
		);
		expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(
			TOOL_RESULT_UNAVAILABLE_MESSAGE,
		);
	});

	it("relays archived canonical output without exposing compacted diagnostics", async () => {
		const privatePath = "/private/ops/raw-release.log";
		const privateData = "AWS_SECRET_ACCESS_KEY=data-never-show";
		const privateError =
			"Authorization: Bearer error-never-show 3f2504e0-4f89-11d3-9a0c-0305e82c3301";
		const paddedRaw =
			`stdout: ${privatePath}\nRAW_DIAGNOSTIC_MARKER\n` +
			"planner diagnostics ".repeat(500);
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-1", name: "LOOKUP", arguments: { query: "release" } },
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-2", name: "LOOKUP", arguments: { query: "release" } },
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{ id: "call-3", name: "SHELL", arguments: { command: "true" } },
				],
			})
			.mockResolvedValueOnce({
				text: "Release inventory contains twelve plugins.",
				toolCalls: [],
			});
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				text: paddedRaw,
				data: { credential: privateData },
				error: privateError,
			})
			.mockResolvedValueOnce({
				success: true,
				text: "planner diagnostics: twelve release plugins",
				userFacingText: "Release inventory contains twelve plugins.",
			})
			.mockResolvedValueOnce({
				success: true,
				text: "stdout: no user-facing projection",
			});
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE" as const,
				thought: "Retry the same release lookup.",
			})
			.mockResolvedValueOnce({
				success: true,
				decision: "CONTINUE" as const,
				thought: "Check one more source.",
			})
			.mockResolvedValueOnce({
				success: true,
				decision: "FINISH" as const,
				thought: "Done.",
				messageToUser: "call:SHELL{command:true}",
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: {
				id: "ctx",
				events: [
					{
						id: "request",
						type: "message",
						message: {
							role: "user",
							content: "Summarize the release inventory.",
						},
					},
					{
						id: "reply-reference",
						type: "provider",
						name: "turn-reference",
						text: "reply_reference: release-thread-17\nturn_state: active",
					},
				],
			},
			tools: [
				{ name: "LOOKUP", description: "Look up records." },
				{ name: "SHELL", description: "Run a shell command." },
			],
			executeToolCall,
			evaluate,
			config: {
				contextWindowTokens: 1200,
				compactionReserveTokens: 1000,
				compactionKeepSteps: 0,
			},
		});

		expect(
			result.trajectory.archivedSteps.some(
				(step) =>
					step.result?.userFacingText ===
					"Release inventory contains twelve plugins.",
			),
		).toBe(true);
		expect(
			result.trajectory.context.events.some(
				(event) =>
					event.type === "segment" &&
					"segment" in event &&
					event.segment.label === "compaction",
			),
		).toBe(true);
		// Compaction does not revoke a canonical receipt or make another model
		// boundary necessary: the archived userFacingText is selected directly.
		expect(useModel).toHaveBeenCalledTimes(3);
		expect(result.finalMessage).toBe(
			"Release inventory contains twelve plugins.",
		);
		expect(result.finalMessage).not.toMatch(
			/private\/ops|RAW_DIAGNOSTIC_MARKER|AWS_SECRET_ACCESS_KEY|Authorization|Bearer|3f2504e0/iu,
		);
		expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(
			result.finalMessage,
		);
	});
});
