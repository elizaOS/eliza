import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulCalls,
  toRecord,
} from "../_helpers/effect-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "selfcontrol.unblock-websites.before-scheduled-end",
  title: "Timed website blocks can be removed before their scheduled end",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "smoke", "multi-turn", "timed-block"],
  description:
    "A timed block should be removable before it naturally expires, and the response should say that clearly.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
    os: "macos",
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Timed Early Unblock",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "start-timed-block",
      room: "main",
      text: "Block x.com for 30 minutes.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/30/i, /x/i, /block/i],
    },
    {
      kind: "message",
      name: "early-unblock",
      room: "main",
      text: "Unblock x.com right now.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/before its scheduled end time/i, /x/i],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "WEBSITE_BLOCK",
      minCount: 1,
    },
    {
      // Effect proof (#11381): turn 1 must have ACTIVATED a 30-minute timed
      // block (durationMinutes:30 with a concrete scheduled end), and turn 2
      // must have actually removed it early — the unblock result
      // {active:false, canUnblockEarly:true}. Handler success without both
      // persisted outcomes fails here.
      type: "custom",
      name: "timed-block-activated-then-removed-early",
      predicate: (ctx) => {
        const calls = successfulCalls(ctx, "WEBSITE_BLOCK");
        const activated = calls.find((call) => {
          const data = toRecord(call.result?.data);
          return (
            data !== null &&
            data.durationMinutes === 30 &&
            typeof data.endsAt === "string" &&
            Array.isArray(data.websites) &&
            data.websites.join(",").includes("x.com") &&
            !("active" in data)
          );
        });
        if (!activated) {
          return `no 30-minute x.com block activation captured; calls: ${describeCalls(ctx)}`;
        }
        const removed = calls.find((call) => {
          const data = toRecord(call.result?.data);
          return data?.active === false && data?.canUnblockEarly === true;
        });
        if (!removed) {
          return `no early-unblock effect ({active:false, canUnblockEarly:true}) captured; calls: ${describeCalls(ctx)}`;
        }
      },
    },
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-timed-early-unblock",
    },
  ],
});
