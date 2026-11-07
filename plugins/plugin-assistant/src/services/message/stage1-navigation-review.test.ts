import { expect, it } from "vitest";
import {
  getStage1RoutingRepair,
  getStage1UnusableDecisionRepair,
} from "./stage1-generation.ts";

const initial: Record<string, unknown> = {
  shouldRespond: "RESPOND",
  contexts: ["simple"],
  intents: [],
  replyText: "",
  replyEffectStatus: "none",
  contextRequests: [],
  visualContinuation: {
    disposition: "direct",
    viewId: "chat",
    reason: "Open Home",
  },
};
const corrected = {
  ...initial,
  contexts: ["general"],
  intents: ["Navigate to Home"],
  replyText: "Going home.",
  replyEffectStatus: "pending",
};
it("includes the known navigation contradiction in the first captured Home correction", () => {
  const input = JSON.stringify(initial);
  const first = getStage1UnusableDecisionRepair(initial);
  if (!first) throw new Error("Expected Stage-1 repair");
  expect(first).toBe(getStage1RoutingRepair(initial));
  expect(first).toContain("nonempty intents");
  expect(first).toContain("replyEffectStatus=pending");
  expect(JSON.stringify(initial)).toBe(input);
  // Deterministic model fixture follows the contract it actually receives.
  const attempts: Record<string, unknown>[] = [initial];
  const response = first.includes("structured navigation declarations conflict")
    ? corrected
    : { ...initial, replyText: "Going home." };
  attempts.push(response);
  const further = getStage1RoutingRepair(response);
  if (further) attempts.push(corrected);
  expect(attempts).toHaveLength(2);
  expect(getStage1UnusableDecisionRepair(corrected)).toBeUndefined();
  expect(getStage1RoutingRepair(corrected)).toBeUndefined();
});
it("retains ordinary empty-answer review and deferred-context behavior", () => {
  const ordinary = {
    ...initial,
    visualContinuation: {
      disposition: "none",
      viewId: "",
      reason: "No navigation",
    },
  };
  expect(getStage1UnusableDecisionRepair(ordinary)).toContain(
    "neither an answer nor pending work",
  );
  expect(
    getStage1UnusableDecisionRepair({
      ...initial,
      contextRequests: ["history:all"],
    }),
  ).toBeUndefined();
  expect(
    getStage1UnusableDecisionRepair({ ...corrected, replyText: "" }),
  ).toBeUndefined();
  expect(
    getStage1UnusableDecisionRepair({ ...initial, shouldRespond: "STOP" }),
  ).toBeUndefined();
  expect(
    getStage1UnusableDecisionRepair(
      { ...initial, shouldRespond: "STOP" },
      { reaskTerminal: true },
    ),
  ).toContain("ended a directly addressed turn with STOP");
});
