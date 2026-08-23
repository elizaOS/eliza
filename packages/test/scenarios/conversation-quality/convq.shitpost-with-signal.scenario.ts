/**
 * Conversation-quality :: shitpost-with-signal
 *
 * Failure mode: the user shares a jokey/absurdist post that actually carries a
 * real idea underneath, and the agent either (a) whiffs on the joke and
 * responds with an earnest literal take, or (b) gets the joke but then dumps an
 * essay. The correct register is: get the joke, add AT MOST one real
 * substantive beat, stay short.
 *
 * Motivating live regression: a shared satirical "collateralize your GPUs"
 * meme-post — the good live outcome (register-matched + one real thesis beat +
 * short) happened by luck, not by default; the default drifts to either a flat
 * literal unpacking or a wall of analysis.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): a char budget (<=450, room for one real beat
 *     but no essay), `responseExcludes` forbidding the earnest-literal tells
 *     ("actually, that would not work because...", safety-lecture phrasing,
 *     "here's a breakdown", numbered-list dumps).
 *   - Qualitative: judgeRubric grades "got the joke AND surfaced the real idea
 *     in one beat, within budget".
 *
 * Synthetic persona (Priya Raman) + fully invented meme-post (collateralized
 * sourdough starters). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const EARNEST_LITERAL =
  /(here('|i)?s a breakdown|let('|)s break (this|it) down|1\.\s.+\n2\.\s|step one|actually,? (that|this) (would|wouldn'?t)|important to note|to be clear,? this is (satire|a joke)|this (post|tweet) is (joking|satirical))/i;

export default scenario({
  lane: "live-only",
  id: "convq.shitpost-with-signal",
  title:
    "Conversation-quality: shitpost with a real idea gets the joke plus one beat",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:shitpost-with-signal",
    "critical",
  ],
  description:
    "The user shares an absurdist meme-post that hides a real idea. The agent should get the joke (match the register) and add at most one substantive beat about the underlying idea — short, no essay, no earnest literal unpacking, no explaining that the post is a joke.",

  isolation: "per-scenario",
  now: "2026-08-30T06:20:00.000Z", // 23:20 America/Los_Angeles

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: shitpost with signal",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-priya",
      content: {
        text: "Owner is Priya Raman, 29, a product designer in Portland building Lanternfish. She shares jokey posts from the internet late at night and likes when the reply gets the bit instead of explaining it.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "shares-shitpost",
      room: "main",
      text: 'lmao someone posted "banks hate this: collateralize your sourdough starter. it literally grows overnight. yield farming but the yield is bread" and honestly... is fermentation-backed lending the next thing',
      responseExcludes: [EARNEST_LITERAL],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "she shared it TO the agent and asked a playful question — expected a short register-matched reply, got empty response";
        }
        if (text.length > 450) {
          return `get the joke, add one real beat, stay short (<=450 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "leans-in",
      room: "main",
      text: "ok but the perishable-collateral part is almost a real problem right",
      // She's pulling the one real thread — a short substantive answer is
      // right here, still no essay.
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "she asked a real question — expected a short substantive reply, got empty response";
        }
        if (text.length > 500) {
          return `one real beat, not a lecture (<=500 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:shitpost-with-signal",
      minimumScore: 0.7,
      rubric:
        "The user shared an absurdist meme-post (collateralizing sourdough starters as 'yield farming but the yield is bread') that hides a real idea (lending against productive/perishable collateral). Turn 1: the assistant must match the playful register — get the joke, riff briefly, and it MAY surface the one real idea underneath in a single beat; it must NOT explain that the post is a joke, must NOT deliver an earnest literal feasibility analysis, and must NOT produce a breakdown/list/essay. Turn 2: the user pulls the real thread ('perishable-collateral part is almost a real problem'); the assistant should give one short substantive beat (e.g. valuation/liquidation of perishable or productive collateral) while keeping the playful frame available — still no essay. Getting the joke AND landing one real beat within budget scores 1.0; whiffing the joke, explaining the joke, or an essay scores 0.0.",
    },
  ],
});
