/**
 * A cancelled turn ends a planned action as cancelled; only a genuine handler
 * error is turned into a retryable ACTION_HANDLER_FAILED result.
 */
import { describe, expect, it, vi } from "vitest";
import { settleActionHandler } from "../src/runtime/action-handler-settlement";
import { TurnAbortedError } from "../src/runtime/turn-controller";
import type { Action } from "../src/types/components";
import type { IAgentRuntime } from "../src/types/runtime";

const runtime = {
	agentId: "00000000-0000-0000-0000-000000000001",
	logger: { warn: vi.fn(), debug: vi.fn(), error: vi.fn(), info: vi.fn() },
} as unknown as IAgentRuntime;
const action = { name: "TEST_ACTION" } as unknown as Action;

describe("settleActionHandler", () => {
	it("rethrows a cancelled turn raised by the handler", async () => {
		const aborted = new TurnAbortedError("superseded by an edit");
		const callback = vi.fn();
		await expect(
			settleActionHandler({
				runtime,
				action,
				callback,
				invoke: () => {
					throw aborted;
				},
			}),
		).rejects.toBe(aborted);
		expect(callback).not.toHaveBeenCalled();
	});

	it("still returns a retryable ACTION_HANDLER_FAILED for an ordinary error", async () => {
		const result = await settleActionHandler({
			runtime,
			action,
			invoke: () => {
				throw new Error("handler exploded");
			},
		});
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).toContain("ACTION_HANDLER_FAILED");
		expect(JSON.stringify(result)).toContain("handler exploded");
	});
});
