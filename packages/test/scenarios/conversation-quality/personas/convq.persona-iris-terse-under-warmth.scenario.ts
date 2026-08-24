/**
 * Conversation-quality :: persona register-hold — IRIS (terse-technical)
 *
 * Persona contract (seeded as a durable owner-fact via `_personas.ts`): Iris
 * answers first, minimal words, no filler openers, no enthusiasm inflation, no
 * hedging padding.
 *
 * Pressure: the owner opens warm and chatty, then gives Iris an easy hook to
 * "warm up" (praise + an open, feelings-adjacent prompt). A persona that only
 * holds terse when the user is terse isn't a persona. Iris must answer the
 * technical question crisply and stay in register — no gushing, no exclamation
 * cheerleading, no "aww thanks!" softening into paragraphs.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): a hard char budget per turn (terse is
 *     measurable) + `responseExcludes` forbidding filler openers, enthusiasm
 *     inflation (multiple !!), and hedging padding.
 *   - Qualitative: judgeRubric confirms the answer is present, correct-shaped,
 *     and in the terse register despite the warm bait.
 *
 * All context is synthetic (Devin Aluko / Tollgate, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { IRIS } from "./_personas";

// Filler openers a terse assistant must never lead with.
const FILLER_OPENER =
  /^(great question|good question|sure thing|absolutely|happy to help|i'?d be happy|of course|certainly!)/i;
// Enthusiasm inflation: two or more exclamation points, or cheerleading.
const ENTHUSIASM_INFLATION =
  /(!!+|so exciting|amazing work|you'?re crushing it|love that|yay\b|woohoo)/i;
// Hedging padding that bloats a factual answer.
const HEDGE_PADDING =
  /(i think maybe|it could possibly|i'?m not totally sure but|if i had to guess|honestly not certain)/i;

export default scenario({
  lane: "live-only",
  id: "convq.persona-iris-terse-under-warmth",
  title: "Persona (Iris/terse): stays terse under warm, chatty bait",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "persona",
    "persona:iris",
    "failure-mode:register-drift",
    "critical",
  ],
  description:
    "Iris's contract is terse-technical. The owner opens warm and praises Iris, then asks a technical question with an open, chatty framing. Iris must answer crisply and hold the terse register — no filler opener, no enthusiasm inflation, no hedging padding, no warming up into paragraphs.",

  isolation: "per-scenario",
  now: "2026-08-30T18:05:00.000Z",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Persona register-hold: Iris",
    },
  ],

  seed: IRIS.seeds,

  turns: [
    {
      kind: "message",
      name: "warm-praise-then-question",
      room: "main",
      text: "honestly you've been a lifesaver this week, love working with you 🙏 anyway — quick one: should i put the idempotency key on the request header or in the body for Tollgate's charge endpoint?",
      responseExcludes: [FILLER_OPENER, ENTHUSIASM_INFLATION, HEDGE_PADDING],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected a terse technical answer, got empty response";
        }
        if (text.length > 320) {
          return `terse register: answer should be short (<=320 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "chatty-followup",
      room: "main",
      text: "makes sense! you're the best. and just curious how you'd feel about us switching the whole thing to gRPC someday?",
      responseExcludes: [FILLER_OPENER, ENTHUSIASM_INFLATION, HEDGE_PADDING],
      assertResponse: (text: string) => {
        if (text.length > 360) {
          return `terse register: stay short even on an open prompt (<=360 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:persona-iris-terse",
      minimumScore: 0.7,
      rubric:
        "The assistant's contract is Iris: terse, answer-first, technical, no filler, no enthusiasm inflation, no hedging padding. The owner was warm and praised Iris, and asked (1) whether an idempotency key belongs in the header or the body, and (2) an open, casual opinion prompt about switching to gRPC. Iris must ANSWER both crisply and correctly-shaped (a header-vs-body recommendation; a short, opinionated take on gRPC) while STAYING in the terse register despite the warmth: no 'aww thanks', no gushing, no exclamation cheerleading, no paragraphs of preamble, no hedging bloat. A brief, warm-neutral acknowledgment (a few words) is fine; warming up into effusive paragraphs is a register break. Terse + correct + un-inflated scores 1.0; warming up into filler/gush/hedging scores 0.0.",
    },
  ],
});
