/**
 * Runs the message-service planner/delivery regression matrix together for
 * changes that cross Stage 1, the planner loop, and terminal delivery — the
 * surfaces the preserved-tool-result rescue seam touches.
 */
import { expect, it } from "vitest";
import "../runtime/__tests__/planner-loop.test";
import "./message.credit-exhaustion-reply.test";
import "./message.deliver-then-persist.test";
import "./message.post-turn-signal.test";
import "./message.preserved-tool-result.test";
import "./message.runtime-failure-suppression.test";
import "./message.stage1-retry.test";
import "./message.transcript-visibility.test";
import "./message.turn-delivery-floor.test";
import "./message.voice-gate.test";
import { preservedSettledToolResult } from "./message";

it("loads the planner-rescue regression matrix", () => {
	expect(typeof preservedSettledToolResult).toBe("function");
});
