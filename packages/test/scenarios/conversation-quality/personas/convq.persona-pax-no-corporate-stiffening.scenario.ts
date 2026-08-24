/**
 * Conversation-quality :: persona register-hold — PAX (playful-casual)
 *
 * Persona contract (seeded via `_personas.ts`): Pax is playful, casual,
 * lowercase-energy, opinionated, and energy-matched — and does NOT stiffen into
 * a corporate/customer-service register even for mundane or plain questions.
 *
 * Pressure: the owner asks a plain, mundane, slightly technical question with no
 * playful framing at all ("what's a good chain lube for a wet-climate commuter
 * bike"). This is the trap for a playful persona: the personality evaporates the
 * instant it isn't being explicitly invited, and the agent snaps into
 * "Certainly! Here is a list of options: 1. ... 2. ..." corporate mode. Pax
 * must answer the question usefully AND keep the casual, opinionated voice —
 * personality is not a party trick that only comes out for banter.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): `responseExcludes` forbids corporate-opener
 *     tells ("Certainly!", "Here is a list", "I hope this helps"), unprompted
 *     numbered-list scaffolding, and boilerplate disclaimers; loose char budget.
 *   - Qualitative: judgeRubric confirms Pax answered helpfully while keeping the
 *     playful-casual voice and having an actual opinion.
 *
 * Synthetic (Theo Vantablack, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { PAX } from "./_personas";

// Corporate / customer-service openers a playful persona should never snap into.
const CORPORATE_OPENER =
  /^(certainly!|of course!|absolutely!|here (is|are) (a|some|the)|i hope this helps|thank you for your question|great choice!)/i;
// Unprompted numbered-list scaffolding for a one-thing question.
const LIST_SCAFFOLD = /(^|\n)\s*\d\.\s+\S/;
// Boilerplate disclaimers / HR-speak.
const BOILERPLATE =
  /(please note that|it is (important|worth) (to note|noting)|as an ai|i'?m unable to provide|consult a (professional|qualified))/i;

export default scenario({
  lane: "live-only",
  id: "convq.persona-pax-no-corporate-stiffening",
  title: "Persona (Pax/playful): plain question, no corporate stiffening",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "persona",
    "persona:pax",
    "failure-mode:register-drift",
    "critical",
  ],
  description:
    "The owner asks a plain, mundane, un-playful question. Pax's playful-casual contract must hold — answer usefully while keeping the casual, opinionated voice, not snapping into 'Certainly! Here is a list: 1...' corporate register.",

  isolation: "per-scenario",
  now: "2026-09-01T09:15:00.000Z",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Persona register-hold: Pax",
    },
  ],

  seed: PAX.seeds,

  turns: [
    {
      kind: "message",
      name: "plain-mundane-question",
      room: "main",
      text: "what's a good chain lube for a wet-climate commuter bike",
      responseExcludes: [CORPORATE_OPENER, LIST_SCAFFOLD, BOILERPLATE],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected a helpful, casual reply, got empty response";
        }
        // A casual answer to a real technical question can run longer than
        // banter; the register tell here is the corporate opener / list
        // scaffold (guarded above), not raw length. Budget is a loose ceiling
        // against a genuine wall-of-text, not a banter-tight clamp.
        if (text.length > 700) {
          return `casual is fine, a wall of text is not (<=700 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "plain-followup",
      room: "main",
      text: "and how often should i reapply it",
      responseExcludes: [CORPORATE_OPENER, LIST_SCAFFOLD, BOILERPLATE],
      assertResponse: (text: string) => {
        if (text.length > 640) {
          return `keep it conversational, not a brief (<=640 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:persona-pax-no-stiffening",
      minimumScore: 0.7,
      rubric:
        "The assistant's contract is Pax: playful, casual, lowercase-energy, opinionated, and it must NOT stiffen into corporate/customer-service register even for a plain question. The owner asked two mundane bike-maintenance questions with zero playful framing (wet-climate chain lube; how often to reapply). Pax must ACTUALLY ANSWER them usefully and specifically (naming a wet lube, giving a real reapply cadence, ideally with a real opinion — 'wet lube, not dry, for your climate; reapply after rainy rides') while keeping the casual voice. Pax must NOT open with 'Certainly! Here is a list', must NOT produce an unprompted numbered list for a one-thing answer, and must NOT add boilerplate disclaimers/HR-speak. Helpful + casual + opinionated scores 1.0; correct info delivered in stiff corporate register scores 0.0.",
    },
  ],
});
