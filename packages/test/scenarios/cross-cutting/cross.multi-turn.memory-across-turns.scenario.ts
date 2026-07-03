/**
 * Multi-turn memory: the agent is told a fact, then asked about it on a
 * later turn. The response to turn 2 must recall the fact from turn 1.
 *
 * De-echoed for #9310: the old recall assertion ("blue") also appeared in
 * the turn-1 text, so a reply that parroted conversation history passed
 * without any recall. Turn 2 now asks for the color's name in Spanish —
 * answering requires recalling "blue" from turn 1 AND producing "azul", a
 * token that appears in no user turn; a planted decoy color must not leak.
 */

import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";

function expectSpanishFavoriteRecall(ctx: ScenarioContext): string | undefined {
  const reply = ctx.turns?.find(
    (turn) => turn.name === "recall-fact",
  )?.responseText;
  if (!reply) {
    return "expected recall-fact turn response";
  }
  if (!/azul/i.test(reply)) {
    return `expected recalled favorite color in Spanish (azul), saw ${JSON.stringify(reply)}`;
  }
  if (/naranja/i.test(reply)) {
    return `expected least-favorite decoy not to leak, saw ${JSON.stringify(reply)}`;
  }
  return undefined;
}

export default scenario({
  lane: "live-only",
  id: "cross.multi-turn.memory-across-turns",
  title: "Agent recalls a user-stated fact on a later turn",
  domain: "cross-cutting",
  tags: ["cross-cutting", "multi-turn", "critical"],
  description:
    "Turn 1 tells the agent the user's favorite color (blue) plus a decoy least-favorite (orange). Turn 2 asks for the favorite, in Spanish. The response must contain 'azul' and not the decoy's translation.",

  isolation: "per-scenario",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cross-cutting: memory across turns",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "state-fact",
      room: "main",
      text: "Please remember this fact for later: my favorite color is blue, and my least favorite is orange. Just acknowledge, don't update any profile fields.",
    },
    {
      kind: "message",
      name: "recall-fact",
      room: "main",
      text: "A moment ago I told you my favorite color. Which one was it? Please reply with that color's name in Spanish.",
      // Recall + derivation: the answer requires remembering "blue" from
      // turn 1 and translating it — "azul" appears in no user turn, so a
      // history-parroting reply cannot pass. The decoy least-favorite must
      // not leak into the answer.
      responseIncludesAny: ["azul"],
      responseExcludes: ["naranja"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must state that the owner's favorite color is blue, expressed in Spanish as 'azul'. Answering with the least-favorite color (orange/naranja), claiming not to know, or answering only in English fails.",
      },
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "multi-turn-favorite-color-recalled-in-spanish",
      predicate: expectSpanishFavoriteRecall,
    },
  ],
});
