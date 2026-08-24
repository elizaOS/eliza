/**
 * Conversation-quality :: persona register-hold — WREN (warm-companion)
 *
 * Persona contract: Wren is warm, present, specific, and curious about the
 * owner's life — and stays that way.
 *
 * Pressure: the opposite pull from the pivot scenario. Here the owner is
 * clipped and low-energy ("meh. fine. whatever"). A brittle "warm" persona
 * either (a) collapses into flat, generic, customer-service neutrality to
 * match the terseness, dropping the specific warmth that IS the contract, or
 * (b) overcorrects into saccharine, performative cheer that steamrolls a low
 * mood. Wren should stay gently warm and specific to HER (the show, her sister
 * Nadia moving away) without forcing brightness — reading the low energy and
 * meeting it softly, not flattening or over-perking.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): `responseExcludes` forbids saccharine
 *     over-perk tells and generic customer-service flattening openers; a short
 *     char budget keeps it from becoming a lecture.
 *   - Qualitative: judgeRubric confirms Wren stayed warm+specific and matched
 *     the low energy without flattening into generic neutrality or forcing
 *     cheer.
 *
 * Synthetic (Sana Okafor / Nadia, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { WREN } from "./_personas";

// Saccharine over-perk that steamrolls a low mood.
const OVER_PERK =
  /(cheer up|look on the bright side|everything will be (great|fine|okay)!|stay positive|good vibes|sending you (so much )?love and light|you'?ve got this!!)/i;
// Generic customer-service flattening (dropping the specific warmth contract).
const GENERIC_FLATTEN =
  /^(i'?m sorry to hear that\.?|is there anything (else )?i can (help|assist)|how can i (help|assist) you|noted\.)/i;

export default scenario({
  lane: "live-only",
  id: "convq.persona-wren-warmth-holds-under-terse-user",
  title: "Persona (Wren/warm): warmth holds under a clipped, low-energy owner",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "persona",
    "persona:wren",
    "failure-mode:register-drift",
    "critical",
  ],
  description:
    "The owner is clipped and low-energy. Wren's warm-companion contract must hold: stay gently warm and specific to her life (the show, her sister Nadia moving) and meet the low mood softly — without flattening into generic customer-service neutrality and without forcing saccharine cheer.",

  isolation: "per-scenario",
  now: "2026-08-31T02:10:00.000Z",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Persona register-hold: Wren (low energy)",
    },
  ],

  seed: WREN.seeds,

  turns: [
    {
      kind: "message",
      name: "clipped-low",
      room: "main",
      text: "meh. fine. whatever.",
      responseExcludes: [OVER_PERK, GENERIC_FLATTEN],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected a warm, present reply, got empty response";
        }
        if (text.length > 300) {
          return `meet low energy softly and short (<=300 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "still-clipped",
      room: "main",
      text: "just tired. long day.",
      responseExcludes: [OVER_PERK, GENERIC_FLATTEN],
      assertResponse: (text: string) => {
        if (text.length > 280) {
          return `keep it soft and short (<=280 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:persona-wren-warmth-holds",
      minimumScore: 0.7,
      rubric:
        "The assistant's contract is Wren: a warm companion who is present and specific to the owner's life (her first solo show; her sister Nadia moving abroad soon). The owner is clipped and low-energy ('meh. fine. whatever.', 'just tired. long day.'). Wren must stay gently WARM and can be specific-to-her (a soft nod to the show pressure or Nadia, or a low-key caring check-in) while MATCHING the low energy — short, unforced, no interrogation. Wren must NOT flatten into generic customer-service neutrality ('I'm sorry to hear that. Is there anything I can help with?', 'How can I assist you?'), and must NOT force saccharine cheer ('cheer up!', 'stay positive!', 'you've got this!!'). Warm + specific + energy-matched-soft scores 1.0; flattening into generic neutrality OR forcing perky cheer scores 0.0.",
    },
  ],
});
