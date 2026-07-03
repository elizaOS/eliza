import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { callPayloadBlob } from "../_helpers/effect-assertions.ts";

function expectConfirmedXBlock(ctx: ScenarioContext): string | undefined {
  const blob = callPayloadBlob(ctx, "WEBSITE_BLOCK");
  if (!/x(?:\.com)?/.test(blob)) {
    return `expected confirmed block payload to reference X, saw ${blob.slice(0, 600)}`;
  }
  if (!/(hour|60|3600)/.test(blob)) {
    return `expected confirmed block payload to carry one-hour duration, saw ${blob.slice(0, 600)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "selfcontrol.self-set-enforcement.enforces-yes",
  title: "Agent enforces a block once the user confirms",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "confirmation", "happy-path"],
  description:
    "Turn 1 — agent proposes a block and must not act. Turn 2 — user confirms; WEBSITE_BLOCK must fire.",
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
      title: "SelfControl Enforces Yes",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "propose-block",
      room: "main",
      text: "Should I block X for an hour while I do deep work?",
      forbiddenActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/block/i, /x/i, /hour/i, /confirm/i, /\?/],
    },
    {
      kind: "message",
      name: "confirm-block",
      room: "main",
      text: "Yes, block it for one hour.",
      expectedActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/blocked/i, /block/i, /hour/i, /x/i],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "confirmed-x-block-carries-duration",
      predicate: expectConfirmedXBlock,
    },
  ],
  cleanup: [
    {
      type: "selfControlClearBlocks",
      profile: "e2e-selfcontrol-enforces-yes",
    },
  ],
});
