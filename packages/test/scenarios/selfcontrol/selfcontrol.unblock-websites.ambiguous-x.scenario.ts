import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulCalls,
  toRecord,
} from "../_helpers/effect-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "selfcontrol.unblock-websites.ambiguous-x",
  title: "Unblock requests do not require restating the hostname",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "multi-turn", "unblock", "clarity"],
  description:
    "When the user clearly wants the current website block removed, 'can you unblock x?' should route to the website unblock action instead of asking what x means.",
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
      title: "SelfControl Ambiguous X Unblock",
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
      name: "ambiguous-unblock-still-routes",
      room: "main",
      text: "Can you unblock x?",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [
        /removed the website block/i,
        /before its scheduled end time/i,
        /no website block is active right now/i,
      ],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "WEBSITE_BLOCK",
      minCount: 1,
    },
    {
      // Effect proof (#11381): turn 1 must have ACTIVATED the 30-minute
      // x.com block, and the ambiguous "unblock x" turn must have reached
      // the unblock path's outcome — a result carrying active:false (either
      // the removal or the no-active no-op). Routing into a clarifying
      // question instead of the unblock handler fails here.
      type: "custom",
      name: "timed-block-then-unblock-outcome",
      predicate: (ctx) => {
        const calls = successfulCalls(ctx, "WEBSITE_BLOCK");
        const activated = calls.find((call) => {
          const data = toRecord(call.result?.data);
          return (
            data !== null &&
            data.durationMinutes === 30 &&
            Array.isArray(data.websites) &&
            data.websites.join(",").includes("x.com") &&
            !("active" in data)
          );
        });
        if (!activated) {
          return `no 30-minute x.com block activation captured; calls: ${describeCalls(ctx)}`;
        }
        const unblockOutcome = calls.find((call) => {
          const data = toRecord(call.result?.data);
          return data?.active === false;
        });
        if (!unblockOutcome) {
          return `no unblock outcome (result carrying active:false) captured; calls: ${describeCalls(ctx)}`;
        }
      },
    },
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-ambiguous-x-unblock",
    },
  ],
});
