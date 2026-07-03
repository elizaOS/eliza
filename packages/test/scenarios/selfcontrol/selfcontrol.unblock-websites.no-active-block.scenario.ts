import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulCalls,
  toRecord,
} from "../_helpers/effect-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "selfcontrol.unblock-websites.no-active-block",
  title: "Unblock request is a clean no-op when nothing is blocked",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "smoke", "noop"],
  description:
    "If no website block is active, the unblock action should still route cleanly and explain that nothing is currently blocked.",
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
      title: "SelfControl No Active Block",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "noop-unblock",
      room: "main",
      text: "Unblock x.com right now.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/no website block is active right now/i],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "WEBSITE_BLOCK",
      minCount: 1,
    },
    {
      // Effect proof (#11381): the unblock handler must have actually read
      // the live block state and reported the clean no-op — the result
      // {active:false, canUnblockEarly:false}. A reply-only "nothing is
      // blocked" without the state read fails here.
      type: "custom",
      name: "unblock-noop-reads-empty-block-state",
      predicate: (ctx) => {
        const noop = successfulCalls(ctx, "WEBSITE_BLOCK").find((call) => {
          const data = toRecord(call.result?.data);
          return data?.active === false && data?.canUnblockEarly === false;
        });
        if (!noop) {
          return `no clean no-op outcome ({active:false, canUnblockEarly:false}) captured; calls: ${describeCalls(ctx)}`;
        }
      },
    },
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-no-active-block",
    },
  ],
});
