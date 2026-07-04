/**
 * Regression coverage for issue elizaOS/eliza#8007:
 * "v5 planner loops on `decision: CONTINUE` without advancing past the first
 *  successful tool call."
 *
 * The reported repro was a multi-step orchestrator turn (TASKS
 * provision_workspace -> spawn_agent -> submit_workspace) where the planner kept
 * re-dispatching the first op (`provision_workspace`) on every CONTINUE turn,
 * 8 successive `ACTION_STARTED actionName=TASKS op=provision_workspace` events,
 * until the trajectory limit fired and Discord showed the 120s timeout.
 *
 * Two framework mechanisms bound and unblock this loop; these tests pin
 * both against the exact orchestrator shape from the issue:
 *
 *  1. Prior successful tool results ARE surfaced into the next planner turn's
 *     messages (via `trajectoryStepsToMessages`), so a capable model can see
 *     "provision already succeeded, now spawn" and advance.
 *  2. When a weak model instead re-issues the IDENTICAL successful call, the
 *     redundant-success loop-breaker executes it once, skips the repeats, and
 *     past `maxRepeatedToolCalls` forces one terminal synthesis instead of
 *     running the turn to the trajectory/token limit.
 */
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop";

describe("v5 planner #8007 - multi-step orchestrator advance", () => {
	const REPO = "acme/hello-world";

	it("advances through distinct sub-ops instead of restarting from the first", async () => {
		const executed: string[] = [];
		const seenMessages: unknown[][] = [];

		const provision = {
			id: "c1",
			name: "TASKS",
			arguments: { action: "provision_workspace", repo: REPO },
		};
		const spawn = {
			id: "c2",
			name: "TASKS",
			arguments: { action: "spawn_agent", repo: REPO },
		};
		const submit = {
			id: "c3",
			name: "TASKS",
			arguments: { action: "submit_workspace", repo: REPO },
		};

		const runtime = {
			useModel: vi.fn(
				async (_modelType: unknown, params: { messages: unknown[] }) => {
					seenMessages.push(params.messages);
					const turn = runtime.useModel.mock.calls.length;
					if (turn === 1) return { text: "", toolCalls: [provision] };
					if (turn === 2) return { text: "", toolCalls: [spawn] };
					return { text: "", toolCalls: [submit] };
				},
			),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};

		const executeToolCall = vi.fn(
			async (toolCall: { params?: { action?: string } }) => {
				const op = toolCall.params?.action ?? "unknown";
				executed.push(op);
				return {
					success: true,
					text: `${op} completed for ${REPO}`,
				};
			},
		);

		// The evaluator advances the plan while ops remain, and finishes once the
		// terminal op (submit_workspace) has completed.
		const evaluate = vi.fn(async () => {
			if (executed.includes("submit_workspace")) {
				return {
					success: true,
					decision: "FINISH" as const,
					messageToUser: "PR opened for hello-world.",
				};
			}
			return {
				success: true,
				decision: "CONTINUE" as const,
				thought: "Keep advancing the multi-step task.",
			};
		});

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "TASKS", description: "Orchestrator task operations." }],
			executeToolCall,
			evaluate,
		});

		// The planner advanced through all three distinct ops in order; it did
		// NOT re-dispatch provision_workspace on the second CONTINUE turn.
		expect(executed).toEqual([
			"provision_workspace",
			"spawn_agent",
			"submit_workspace",
		]);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toContain("PR opened");

		// The prior successful step must be visible to the model on the next
		// planner turn; this is the exact signal #8007 said was missing ("the
		// LLM does not see 'you already provisioned a workspace, now spawn'").
		const secondTurnMessages = JSON.stringify(seenMessages[1] ?? []);
		expect(secondTurnMessages).toContain("provision_workspace completed");
	});

	it("bounds a weak model that re-issues the identical successful op (no 8x loop)", async () => {
		// Exact #8007 repro: the planner keeps emitting the same
		// TASKS provision_workspace call every CONTINUE turn. The redundant
		// loop-breaker runs it once, skips the repeats, and forces a terminal
		// synthesis: no TrajectoryLimitExceeded, no 120s Discord timeout.
		const provision = {
			id: "p1",
			name: "TASKS",
			arguments: { action: "provision_workspace", repo: REPO },
		};

		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce({ text: "", toolCalls: [provision] })
				.mockResolvedValueOnce({ text: "", toolCalls: [provision] })
				.mockResolvedValueOnce({ text: "", toolCalls: [provision] })
				.mockResolvedValueOnce(
					'{"thought":"Workspace already provisioned.","messageToUser":"Workspace is ready.","toolCalls":[]}',
				),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};

		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "workspace ws-1 provisioned",
		}));

		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "CONTINUE" as const,
			thought: "Not done yet.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [{ name: "TASKS", description: "Orchestrator task operations." }],
			config: { maxRepeatedToolCalls: 1 },
			executeToolCall,
			evaluate,
		});

		// Provision ran exactly once; the identical repeats were skipped, not
		// re-executed 8x.
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toContain("ready");
	});
});
