/** Local measurement only (not committed). Explorer angle history-receipts.
 *
 * Stage 1 binds the history window to the exact source set it saw. When the
 * planner's context holds one more original (a message that landed while Stage 1
 * ran) or a changed recorded outcome (a proposal that ended meanwhile), the
 * planner and evaluator silently show the whole conversation. This reproduces
 * that with the runtime's own functions and shows the same checkpoint can be
 * projected onto the planner's sources. */
import type { ContextEvent } from "@elizaos/core";
import { expect, it } from "vitest";
import { windowHistoryRetention } from "../runtime/history-retention.ts";
import {
  projectBackgroundHistory,
  projectReviewedHistory,
  withBackgroundHistory,
} from "../services/message/history-discovery.ts";

const scope = {
  agentId: "agent",
  roomId: "room",
  entityId: "owner",
  roles: ["OWNER"],
};

function room(count: number, extra: ContextEvent[] = []) {
  return {
    id: "turn",
    metadata: { roomId: "room", messageId: "turn" },
    events: [
      ...Array.from(
        { length: count },
        (_, i): ContextEvent => ({
          id: `history:${i}`,
          type: "segment",
          source: "prior-dialogue",
          segment: {
            id: `history:${i}`,
            label: `prior_message:${i % 2 ? "agent" : "user"}`,
            content: `original-${i}.`,
            stable: false,
            metadata: {
              roomId: "room",
              entityId: i % 2 ? "agent" : "owner",
            },
          },
        }),
      ),
      ...extra,
    ],
  };
}

const effect = (request: number, outcome: string): ContextEvent => ({
  id: `historical-effects:${request}`,
  type: "segment",
  source: "message-service",
  segment: {
    id: `historical-effects:${request}`,
    label: "runtime:historical_effects",
    stable: false,
    content: JSON.stringify({
      requestSourceEventId: `history:${request}`,
      scope: "Past recorded outcomes only.",
      outcomes: [
        {
          actionName: "PROPOSE_DEVICE_ACTION",
          success: true,
          receipt: {
            receiptId: "r1",
            operation: "device.phone_call",
            resource: { kind: "device.approval", id: "r1" },
            artifacts: [],
            idempotency: { key: "device:k", replayed: false },
            observedAt: "2026-11-20T21:15:04.179Z",
            outcome,
          },
        },
      ],
    }),
  },
});

const shown = (context: ReturnType<typeof room>) =>
  context.events.filter((event) => event.source === "prior-dialogue").length;

it("x: the planner loses the window when its sources differ from Stage 1's", () => {
  // Stage 1 sees 61 earlier messages and windows them.
  const stage1Context = room(61);
  const window = windowHistoryRetention(stage1Context, scope, null);
  expect(window.windowed).toBe(true);
  const history = projectReviewedHistory(
    stage1Context,
    scope,
    window.checkpoint,
  );
  if (!history) throw new Error("no window");
  history.windowed = true;

  // Same sources when the planner assembles its context: the window holds.
  const same = projectBackgroundHistory(
    withBackgroundHistory(room(61), history),
  );
  expect(same.applied).toBe(true);
  expect(same.omittedSourceCount).toBe(40);
  expect(shown(same.context)).toBe(21);

  // One message landed between Stage 1 and the planner: the whole room is shown.
  const plannerContext = room(62);
  const lost = projectBackgroundHistory(
    withBackgroundHistory(plannerContext, history),
  );
  expect(lost.applied).toBe(false);
  expect(shown(lost.context)).toBe(62);

  // A recorded outcome changed meanwhile (same messages): also the whole room.
  const stage1WithEffect = room(61, [effect(58, "preview")]);
  const windowWithEffect = windowHistoryRetention(
    stage1WithEffect,
    scope,
    null,
  );
  const historyWithEffect = projectReviewedHistory(
    stage1WithEffect,
    scope,
    windowWithEffect.checkpoint,
  );
  if (!historyWithEffect) throw new Error("no window");
  const lostOnOutcome = projectBackgroundHistory(
    withBackgroundHistory(room(61, [effect(58, "applied")]), historyWithEffect),
  );
  expect(lostOnOutcome.applied).toBe(false);

  // Prototype of the fix: the checkpoint binds only the deferred prefix, which
  // is unchanged, so it projects onto the planner's own sources.
  const rebound = projectReviewedHistory(
    plannerContext,
    scope,
    history.checkpoint,
  );
  expect(rebound).toBeDefined();
  if (!rebound) return;
  rebound.windowed = true;
  const kept = projectBackgroundHistory(
    withBackgroundHistory(plannerContext, rebound),
  );
  expect(kept.applied).toBe(true);
  expect(kept.omittedSourceCount).toBe(40);
  expect(shown(kept.context)).toBe(22);
  expect(kept.windowed).toBe(true);
  console.log(
    `x-history-receipts: same sources ${shown(same.context)} shown; one more message ${shown(lost.context)} shown (window lost); rebound ${shown(kept.context)} shown`,
  );
});
