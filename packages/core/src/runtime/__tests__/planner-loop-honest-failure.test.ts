/**
 * Honest failed-turn replies (#17948): a planner turn that ends on a failed
 * step keeps the machine-recorded failure authoritative across exec failures,
 * thrown timeouts, validation rejects, structural retryable:false results,
 * and multi-step turns that fail late. Unresolved operations remain
 * machine-owned even when an evaluator invents a diagnosis. The suite pins
 * the shared model projection, provider routing, prompt hygiene, and
 * deterministic terminal persistence.
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
	it("exec failure then REPLY: retries once but skips unresolved-failure synthesis", async () => {
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
			// terminal REPLY, but the unresolved tool remains authoritative.
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "REPLY",
						arguments: { text: "I hit an error while checking the log." },
					},
				],
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
		expect(useModel).toHaveBeenCalledTimes(2);
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
	});

	it("thrown timeout: machine failure authority outranks the evaluator's diagnosis", async () => {
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
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
	});

	it("validation reject: diagnostic text remains retry context, not terminal authority", async () => {
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
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
	});

	it("retryable:false structured failure skips unresolved-failure synthesis", async () => {
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
			.mockResolvedValueOnce({ text: "Deployment failed.", toolCalls: [] });
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

		// The structural non-retryable failure is never blindly re-executed or
		// sent through a post-turn model boundary.
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
	});

	it("retains forced synthesis after the same operation resolves its failure", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "deploy-1",
						name: "DEPLOY_APP",
						arguments: { release: "candidate" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "deploy-2",
						name: "DEPLOY_APP",
						arguments: { release: "candidate" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "The candidate deployed successfully on the retry.",
				toolCalls: [],
			});
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				text: "temporary deployment lock",
			})
			.mockResolvedValueOnce({
				success: true,
				text: "deployment retry completed",
				userFacingText: "Candidate deployment receipt: release-42",
			});
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE" as const,
				thought: "Retry the exact operation.",
			})
			.mockResolvedValueOnce({
				success: true,
				decision: "FINISH" as const,
				thought: "The retry resolved the operation.",
				messageToUser: FAILED_TOOL_FALLBACK_MESSAGE,
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			provider: "pinned-provider",
			tools: [{ name: "DEPLOY_APP", description: "Deploy an app." }],
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).toHaveBeenCalledTimes(2);
		expect(useModel).toHaveBeenCalledTimes(3);
		expect(
			useModel.mock.calls.every((call) => call[2] === "pinned-provider"),
		).toBe(true);
		const resolvedInstruction = loopComposedInstructionText(
			useModel,
			2,
			"later authoritative tool results resolved every operation",
		);
		expect(resolvedInstruction).toContain("canonical tool authority");
		expect(resolvedInstruction).not.toContain("temporary deployment lock");
		expect(result.finalMessage).toBe(
			"The candidate deployed successfully on the retry.",
		);
		expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(
			result.finalMessage,
		);
	});

	it("multi-step turn: a late failure cannot be laundered by evaluator prose", async () => {
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
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
	});

	it("rejects an unsafe evaluator diagnosis without an extra model call", async () => {
		const useModel = vi.fn().mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "call-1",
					name: "SHELL",
					arguments: { command: "ls" },
				},
			],
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

		expect(useModel).toHaveBeenCalledTimes(1);
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
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
	});

	it("does not reach the synthesis provider for an unresolved failure", async () => {
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
			});
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

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
	});
});

describe("deterministic post-turn relay", () => {
	it("emits machine-owned failure authority without contradictory synthesis", async () => {
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

		expect(useModel).toHaveBeenCalledTimes(3);
		expect(
			useModel.mock.calls.every((call) => call[2] === "pinned-provider"),
		).toBe(true);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
		expect(result.finalMessage).not.toMatch(
			/ready to ship|completed successfully/iu,
		);
		expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(
			FAILED_TOOL_FALLBACK_MESSAGE,
		);
	});

	it("projects the default evaluator call without unresolved credentials, params, paths, or ids", async () => {
		const diagnostic =
			"command_failed at /private/ops for job 3f2504e0-4f89-11d3-9a0c-0305e82c3301; API_TOKEN=never-show; Authorization: Bearer bearer-never-show";
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "PLANNER_THOUGHT_NEVER_SHOW",
				toolCalls: [
					{
						id: "CALL_ID_NEVER_SHOW",
						name: "SHELL",
						arguments: {
							command: "deploy",
							token: "PARAM_TOKEN_NEVER_SHOW",
						},
					},
				],
			})
			.mockResolvedValueOnce({
				object: {
					success: false,
					decision: "FINISH",
					thought: "I should not infer a cause from hidden diagnostics.",
					messageToUser: "The credentials were definitely rejected.",
				},
			});
		const executeToolCall = vi.fn(async () => ({
			success: false,
			text: diagnostic,
			error: diagnostic,
			data: { secret: "RESULT_DATA_NEVER_SHOW" },
		}));

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: {
				id: "ctx",
				events: [
					{
						id: "request",
						type: "message",
						message: { role: "user", content: "Deploy the release." },
					},
					{
						id: "provider",
						type: "provider",
						name: "SAFE_PROVIDER",
						text: "SAFE_PROVIDER_CONTEXT",
					},
					{
						id: "instruction",
						type: "instruction",
						content: "SAFE_ORIGINAL_INSTRUCTION",
					},
					{
						id: "reply-reference",
						type: "segment",
						segment: {
							label: "reply_reference",
							content: "SAFE_REPLY_REFERENCE",
							stable: false,
						},
					},
					{
						id: "terminal-output",
						type: "terminal_planner_output",
						metadata: { text: "TERMINAL_OUTPUT_NEVER_SHOW" },
					},
					{
						id: "evaluation",
						type: "evaluation",
						metadata: { thought: "EVALUATOR_OUTPUT_NEVER_SHOW" },
					},
					{
						id: "compaction",
						type: "segment",
						segment: {
							label: "compaction",
							content: "COMPACTION_OUTPUT_NEVER_SHOW",
							stable: false,
						},
					},
				],
			},
			provider: "pinned-provider",
			tools: [{ name: "SHELL", description: "Run a shell command." }],
			executeToolCall,
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(
			useModel.mock.calls.every((call) => call[2] === "pinned-provider"),
		).toBe(true);
		const evaluatorInput = JSON.stringify(useModel.mock.calls[1]?.[1]);
		expect(evaluatorInput).toContain("tool_authority");
		expect(evaluatorInput).toContain("Deploy the release.");
		expect(evaluatorInput).toContain("SAFE_PROVIDER_CONTEXT");
		expect(evaluatorInput).toContain("SAFE_ORIGINAL_INSTRUCTION");
		expect(evaluatorInput).toContain("SAFE_REPLY_REFERENCE");
		expect(evaluatorInput).toContain('tool_name: \\"SHELL\\"');
		expect(evaluatorInput).toContain("machine_status: failed");
		expect(evaluatorInput).toContain("canonical_user_facing_text: unavailable");
		expect(evaluatorInput).not.toMatch(
			/private\/ops|3f2504e0|API_TOKEN|Authorization|Bearer|bearer-never-show|PLANNER_THOUGHT_NEVER_SHOW|CALL_ID_NEVER_SHOW|PARAM_TOKEN_NEVER_SHOW|RESULT_DATA_NEVER_SHOW|TERMINAL_OUTPUT_NEVER_SHOW|EVALUATOR_OUTPUT_NEVER_SHOW|COMPACTION_OUTPUT_NEVER_SHOW/iu,
		);
		expect(result.finalMessage).toBe(FAILED_TOOL_FALLBACK_MESSAGE);
		expect(result.finalMessage).not.toBe(
			"The credentials were definitely rejected.",
		);
		expect(result.finalMessage).not.toMatch(
			/private\/ops|3f2504e0|API_TOKEN|never-show/iu,
		);
		expect(result.trajectory.steps[0]?.result?.text).toBe(diagnostic);
		const terminalSteps = result.trajectory.steps.filter(
			(step) => step.terminalOnly === true,
		);
		expect(terminalSteps).toHaveLength(1);
		expect(terminalSteps[0]?.terminalMessage).toBe(result.finalMessage);
	});

	it("preserves verified success authority and provider routing through the default evaluator", async () => {
		const canonical = "Release receipt: twelve plugins verified.";
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "SUCCESS_THOUGHT_NEVER_SHOW",
				toolCalls: [
					{
						id: "SUCCESS_CALL_ID_NEVER_SHOW",
						name: "LOOKUP",
						arguments: { token: "SUCCESS_PARAM_NEVER_SHOW" },
					},
				],
			})
			.mockResolvedValueOnce({
				object: {
					success: true,
					decision: "FINISH",
					thought: "The verified result completes the request.",
				},
			});

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			provider: "pinned-provider",
			tools: [{ name: "LOOKUP", description: "Look up records." }],
			executeToolCall: async () => ({
				success: true,
				text: "stdout: /private/release API_TOKEN=success-never-show",
				data: { secret: "SUCCESS_DATA_NEVER_SHOW" },
				userFacingText: canonical,
				verifiedUserFacing: true,
				turnComplete: false,
			}),
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(
			useModel.mock.calls.every((call) => call[2] === "pinned-provider"),
		).toBe(true);
		const evaluatorInput = JSON.stringify(useModel.mock.calls[1]?.[1]);
		expect(evaluatorInput).toContain(
			`canonical_user_facing_text: \\"${canonical}\\"`,
		);
		expect(evaluatorInput).not.toMatch(
			/private\/release|API_TOKEN|success-never-show|SUCCESS_THOUGHT_NEVER_SHOW|SUCCESS_CALL_ID_NEVER_SHOW|SUCCESS_PARAM_NEVER_SHOW|SUCCESS_DATA_NEVER_SHOW/iu,
		);
		expect(result.finalMessage).toBe(canonical);
		expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(canonical);
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
