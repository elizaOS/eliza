/**
 * Ambiguity handling: the user asks to "Message John" while the Rolodex
 * contains three different Johns. The agent must ask a clarifying question
 * before sending anything. MESSAGE firing is a hard failure.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoActionCalled } from "../_helpers/effect-assertions.ts";

function expectClarificationWithoutMessage(
  ctx: ScenarioContext,
): string | undefined {
  const forbidden = expectNoActionCalled(ctx, ["MESSAGE"]);
  if (forbidden) return forbidden;

  const reply = ctx.turns?.at(-1)?.responseText ?? "";
  if (
    !/(which|clarif|specif|who.*mean|more than one|multiple|full name|last name|\?)/i.test(
      reply,
    )
  ) {
    return `expected clarifying reply for ambiguous John, saw ${JSON.stringify(reply)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "cross.ambiguity.agent-asks-clarifying-question",
  title: "Ambiguous contact name triggers a clarifying question",
  domain: "cross-cutting",
  tags: ["cross-cutting", "ambiguity", "happy-path"],
  description:
    "Three seeded contacts named John. The user says 'Message John'. The agent must ask which John — not pick one silently or fire MESSAGE.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: ambiguity",
    },
  ],

  seed: [
    {
      type: "contact",
      name: "John Smith",
      handles: [{ platform: "telegram", identifier: "@johnsmith" }],
    },
    {
      type: "contact",
      name: "John Doe",
      handles: [{ platform: "telegram", identifier: "@johndoe" }],
    },
    {
      type: "contact",
      name: "John Chen",
      handles: [{ platform: "telegram", identifier: "@johnchen" }],
    },
  ],

  turns: [
    {
      kind: "message",
      name: "ambiguous-message-john",
      room: "main",
      text: "Message John",
      forbiddenActions: ["MESSAGE"],
      responseIncludesAny: [
        "which",
        "Which",
        "disambiguate",
        "John Smith",
        "John Doe",
        "John Chen",
        /clarif/i,
        /specif/i,
        /who.*mean/i,
        /more than one/i,
        /multiple/i,
        /full name/i,
        /last name/i,
        "?",
      ],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "ambiguous-contact-clarified-without-message",
      predicate: expectClarificationWithoutMessage,
    },
  ],
});
