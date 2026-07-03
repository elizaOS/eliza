import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulCalls,
  toRecord,
} from "../_helpers/effect-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "selfcontrol.block-websites.manual-indefinite",
  title: "Block X with no duration until manual unblock",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "smoke", "manual-block", "multi-turn"],
  description:
    "If the user does not specify a duration, the website block should stay active until they explicitly remove it.",
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
      title: "SelfControl Manual Indefinite Block",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "start-manual-block",
      room: "main",
      text: "Block x.com so I stop doomscrolling.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/until/i, /unblock/i, /x/i],
      assertTurn: (turn) => {
        const hit = turn.actionsCalled.find(
          (action) => action.actionName === "WEBSITE_BLOCK",
        );
        if (!hit) {
          return "Expected WEBSITE_BLOCK to fire for the manual block request.";
        }
        const blob = JSON.stringify({
          parameters: hit.parameters ?? null,
          result: hit.result?.data ?? null,
        });
        if (!/"durationMinutes":null/.test(blob)) {
          return `Expected the manual block to persist with durationMinutes=null. Payload: ${blob}`;
        }
      },
    },
    {
      kind: "message",
      name: "remove-manual-block",
      room: "main",
      text: "Okay, unblock x.com now.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/removed/i, /x/i, /block/i],
      assertTurn: (turn) => {
        if (/scheduled end time/i.test(turn.responseText ?? "")) {
          return `Manual unblock should not talk about a scheduled end time. Response: ${turn.responseText}`;
        }
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "WEBSITE_BLOCK",
      minCount: 1,
    },
    {
      // Effect proof (#11381): turn 1 must have ACTIVATED an indefinite
      // block — a successful result carrying x.com with durationMinutes:null
      // and no scheduled end — and turn 2 must have actually torn it down
      // (the unblock result {active:false, canUnblockEarly:true}). Handler
      // success without those persisted outcomes fails here.
      type: "custom",
      name: "manual-block-activated-then-removed",
      predicate: (ctx) => {
        const calls = successfulCalls(ctx, "WEBSITE_BLOCK");
        const activated = calls.find((call) => {
          const data = toRecord(call.result?.data);
          return (
            data !== null &&
            data.durationMinutes === null &&
            data.endsAt === null &&
            Array.isArray(data.websites) &&
            data.websites.join(",").includes("x.com") &&
            !("active" in data)
          );
        });
        if (!activated) {
          return `no indefinite x.com block activation captured; calls: ${describeCalls(ctx)}`;
        }
        const removed = calls.find((call) => {
          const data = toRecord(call.result?.data);
          return data?.active === false && data?.canUnblockEarly === true;
        });
        if (!removed) {
          return `no unblock effect ({active:false, canUnblockEarly:true}) captured; calls: ${describeCalls(ctx)}`;
        }
      },
    },
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-manual-indefinite",
    },
  ],
});
