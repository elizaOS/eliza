import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoActionCalled } from "../_helpers/effect-assertions.ts";

function expectClarificationBeforeBlock(
  ctx: ScenarioContext,
): string | undefined {
  const forbidden = expectNoActionCalled(ctx, ["WEBSITE_BLOCK"]);
  if (forbidden) return forbidden;

  const reply = ctx.turns?.at(-1)?.responseText ?? "";
  if (!/(which|what|how long|confirm|\?)/i.test(reply)) {
    return `expected clarification before enforcing a loose block request, saw ${JSON.stringify(reply)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "selfcontrol.self-set-enforcement.ask-before",
  title: "Agent confirms blocking plan before enforcing",
  domain: "selfcontrol",
  tags: ["lifeops", "selfcontrol", "confirmation", "ambiguity"],
  description:
    "Turn 1 — user makes a blocking request that is loose; agent must clarify and not immediately enforce the block. No WEBSITE_BLOCK fires on turn 1.",
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
      title: "SelfControl Ask Before Enforcing",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "loose-block-request",
      room: "main",
      text: "I think I need to block some distractions today.",
      forbiddenActions: ["WEBSITE_BLOCK"],
      responseIncludesAny: [/which/i, /what/i, /how long/i, /confirm/i, /\?/],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "loose-selfcontrol-request-asks-before-blocking",
      predicate: expectClarificationBeforeBlock,
    },
  ],
});
