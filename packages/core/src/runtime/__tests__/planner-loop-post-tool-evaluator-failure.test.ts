/**
 * Covers the planner loop's post-tool evaluator-failure recovery: when the
 * in-loop evaluator model call fails with an EXPECTED provider error AFTER a
 * non-terminal tool already succeeded, the loop relays that tool's opt-in
 * `userFacingText` instead of discarding the turn — but rethrows when nothing
 * succeeded, when the error is a programmer/non-provider bug, or when the tool
 * exposed no user-facing text (a log-shaped result must never leak). Deterministic
 * — vitest-mocked `useModel` + injected `executeToolCall`/`evaluate`; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop";

// Planner turn that emits exactly one non-terminal tool call and no
// messageToUser — the shape from trajectory tj-dc0181fe5c9075 where the tool ran,
// then the evaluator's model call failed.
function plannerEmitsToolCall(name: string) {
	return {
		useModel: vi.fn().mockResolvedValueOnce({
			text: "",
			toolCalls: [{ id: "call-1", name, arguments: {} }],
			usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
		}),
	};
}

// Provider HTTP failure carrying the structural status the AI SDK surfaces on
// `APICallError.statusCode` — the incident was an elizaOS Cloud HTTP 400.
function providerHttpError(status: number, message: string): Error {
	const err = new Error(message) as Error & { statusCode: number };
	err.statusCode = status;
	return err;
}

describe("planner-loop — post-tool evaluator failure recovery", () => {
	it("relays the successful tool result when the evaluator provider call fails (HTTP 400)", async () => {
		// The real FILE write action marks its confirmation user-facing
		// (`userFacingSuccessResult`); mirror that opt-in here.
		const wrote = "Wrote 16 bytes to /home/milady/hello-elizacode.txt";
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: wrote,
			userFacingText: wrote,
		}));
		const evaluate = vi.fn(async () => {
			throw providerHttpError(400, "Bad Request");
		});

		const result = await runPlannerLoop({
			runtime: plannerEmitsToolCall("FILE"),
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage ?? "").toContain(wrote);
	});

	it("does NOT mask a genuine failure — rethrows when no tool succeeded", async () => {
		const executeToolCall = vi.fn(async () => ({
			success: false,
			error: "disk full",
			text: "FILE failed: disk full",
		}));
		const evaluate = vi.fn(async () => {
			throw providerHttpError(400, "Bad Request");
		});

		await expect(
			runPlannerLoop({
				runtime: plannerEmitsToolCall("FILE"),
				context: { id: "ctx" },
				executeToolCall,
				evaluate,
			}),
		).rejects.toThrow("Bad Request");
	});

	it("propagates a non-provider error even when a tool succeeded — not a bug-swallower", async () => {
		// A programmer/schema bug carries no HTTP status or network code, so it must
		// surface instead of being masked as a finished turn by the relay.
		const wrote = "Wrote 16 bytes to /home/milady/hello-elizacode.txt";
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: wrote,
			userFacingText: wrote,
		}));
		const evaluate = vi.fn(async () => {
			throw new TypeError(
				"cannot read properties of undefined (reading 'decision')",
			);
		});

		await expect(
			runPlannerLoop({
				runtime: plannerEmitsToolCall("FILE"),
				context: { id: "ctx" },
				executeToolCall,
				evaluate,
			}),
		).rejects.toThrow(TypeError);
	});

	it("does not leak log-shaped output — a tool without userFacingText is never relayed", async () => {
		// A raw SHELL/fetch-style tool result emits log-shaped `text` (prompts, exit
		// codes, raw bodies) and leaves userFacingText unset. When the evaluator
		// provider-throws after it, the relay must not dump that log into the user
		// channel; with nothing user-facing to relay it rethrows the provider error
		// instead.
		const shellLog =
			"$ cat secrets.txt\nexit 0\ncwd=/home/milady\nAWS_SECRET=leak-me";
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: shellLog,
		}));
		const evaluate = vi.fn(async () => {
			throw providerHttpError(429, "Too Many Requests");
		});

		await expect(
			runPlannerLoop({
				runtime: plannerEmitsToolCall("SHELL"),
				context: { id: "ctx" },
				executeToolCall,
				evaluate,
			}),
		).rejects.toThrow("Too Many Requests");
	});

	it("does not regress the happy path — returns the evaluator's message on FINISH", async () => {
		const evaluatorMessage =
			"Created hello-elizacode.txt with ELIZA CODE WORKS.";
		const wrote = "Wrote 16 bytes to /home/milady/hello-elizacode.txt";
		// FILE now sets userFacingText, yet an explicit evaluator messageToUser
		// still outranks it (verifiedUserFacing is deliberately unset).
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: wrote,
			userFacingText: wrote,
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			messageToUser: evaluatorMessage,
			thought: "Done.",
		}));

		const result = await runPlannerLoop({
			runtime: plannerEmitsToolCall("FILE"),
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(evaluatorMessage);
	});
});
