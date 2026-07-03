import { scenario } from "@elizaos/scenario-runner/schema";
import {
  describeCalls,
  successfulCalls,
  toRecord,
} from "../_helpers/effect-assertions.ts";

export default scenario({
  lane: "live-only",
  id: "selfcontrol.override-requires-auth",
  title: "Early unblock asks whether a block exists first",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "clarification", "unblock"],
  description:
    "When the user asks for a quick unblock without enough context, the assistant checks active block state and asks whether X is currently blocked before proceeding.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "SelfControl Override Clarification",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-early-unblock",
      room: "main",
      text: "Unblock X for me — I just need it for a minute.",
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "REPLY",
      minCount: 1,
    },
    {
      type: "actionCalled",
      actionName: "LIST_ACTIVE_BLOCKS",
      minCount: 1,
    },
    {
      // Effect proof (#11381): "checks active block state" means the
      // list_active handler actually read the live rule store — its result
      // must carry the rules array (empty on a fresh runtime). A handler
      // that "succeeds" without the store read fails here.
      type: "custom",
      name: "active-blocks-read-before-answering",
      predicate: (ctx) => {
        const call = successfulCalls(ctx, "LIST_ACTIVE_BLOCKS")[0];
        const data = toRecord(call?.result?.data);
        if (!data || !Array.isArray(data.rules)) {
          return `expected LIST_ACTIVE_BLOCKS to return the live rules array; calls: ${describeCalls(ctx)}`;
        }
      },
    },
  ],
});
