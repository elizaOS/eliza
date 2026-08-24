/**
 * Conversation-quality :: low-energy-match
 *
 * Failure mode: the user sends a terse, low-effort beat ("lol", "nice", a bare
 * emoji) closing out an exchange, and the agent responds with a paragraph —
 * recapping, re-offering help, asking a follow-up question chain. Matching
 * register means matching ENERGY: a terse close gets a terse (or zero)
 * response, not an essay.
 *
 * This is the low end of register-matching that "add more personality" fixes
 * miss entirely: the skill being tested is knowing when the conversation is
 * OVER and letting it be over.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): brutal char budgets on the low-energy turns
 *     (<=60 / <=60), plus `responseExcludes` forbidding the re-engagement
 *     tells (follow-up question marks framed as "anything else", recaps,
 *     "let me know if").
 *   - Qualitative: judgeRubric grades "let the exchange end; no re-opening".
 *
 * Synthetic persona (Priya Raman). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const REOPENERS =
  /(anything else|let me know if|is there anything|want me to|shall i|to recap|in summary|as (i|we) (mentioned|discussed)|how (are you|was your)|what (else|about))/i;

export default scenario({
  lane: "live-only",
  id: "convq.low-energy-match",
  title: "Conversation-quality: a terse close gets a terse (or zero) response",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:low-energy-match",
    "critical",
  ],
  description:
    "After a completed exchange the user sends low-effort closers ('lol nice', a bare thumbs-up emoji). The agent must match the low energy: at most a few words, or nothing — no paragraph, no recap, no 'anything else?' re-opening of a conversation the user just closed.",

  isolation: "per-scenario",
  now: "2026-08-30T05:45:00.000Z", // 22:45 America/Los_Angeles

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: low energy",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-priya",
      content: {
        text: "Owner is Priya Raman, 29, a product designer in Portland building Lanternfish. Earlier this evening the assistant helped her pick a font pairing for a landing page and the task is done.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "setup-beat",
      room: "main",
      text: "shipped the landing page with that font pairing, my cofounder said it looks 'suspiciously professional'",
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "a small win share deserves a short human beat, got empty response";
        }
        if (text.length > 200) {
          return `a win share gets a short beat, not a speech (<=200 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "low-energy-lol",
      room: "main",
      text: "lol nice",
      responseExcludes: [REOPENERS],
      assertResponse: (text: string) => {
        if (text && text.length > 60) {
          return `'lol nice' is a closer — match it with a few words or nothing (<=60 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "low-energy-emoji",
      room: "main",
      text: "👍",
      responseExcludes: [REOPENERS],
      assertResponse: (text: string) => {
        if (text && text.length > 60) {
          return `a bare emoji ends the exchange — silence or an equally tiny beat (<=60 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:low-energy-match",
      minimumScore: 0.7,
      rubric:
        "The user shared a small win (turn 1), then closed the exchange with low-effort beats: 'lol nice' (turn 2) and a bare thumbs-up emoji (turn 3). Turn 1 deserves one short human beat. Turns 2 and 3 are closers: the assistant must match the low energy — a few words at most, or nothing at all. It must NOT send a paragraph, must NOT recap the work, must NOT ask 'anything else?' or otherwise re-open a conversation the user just ended, and must NOT force a follow-up question. Letting the exchange end gracefully scores 1.0; any re-opening, recap, or verbose reply on turns 2-3 scores 0.0.",
    },
  ],
});
