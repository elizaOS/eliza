/**
 * Conversation-quality :: roll-call-satire
 *
 * Failure mode: a human does a playful multi-mention roll call ("ROLL CALL
 * @X @Y @Z who is ALIVE in here") — obviously a bit — and the agent answers it
 * dead-literal, like a form: "I'm awake, how can I help?" / "Online and
 * operational, what do you need?". The correct register is to read it as a bit
 * and play it back in ONE short line, with no assistant-services pivot.
 *
 * Motivating live regression: a playful roll call across several agents drew
 * literal earnest status reports ("awake, what's up") from every agent — no
 * read of the satire.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): a hard char budget (one line, <=120) plus
 *     `responseExcludes` forbidding the literal-status and assistant-pivot
 *     tells ("how can I help", "what do you need", "operational",
 *     "at your service", "standing by").
 *   - Qualitative: judgeRubric grades "read it as a bit, one light line,
 *     didn't answer like a form".
 *
 * Synthetic group (The Porch: Marcus, Dee, Toph + agent + two other synthetic
 * bots Quill/Marble). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const LITERAL_STATUS =
  /(how can i (help|assist)|what (do you need|can i do for)|i('| a)?m (awake|online|here|active|operational|up and running)|status report|standing by|at your service|ready to (help|assist)|anything you need)/i;

export default scenario({
  lane: "live-only",
  id: "convq.roll-call-satire",
  title: "Conversation-quality: playful roll call gets the bit, not a form",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:roll-call-satire",
    "critical",
  ],
  description:
    "A human does an obviously playful roll call mentioning the agent and two other bots. The agent must read it as a bit and play it back in one short line — no literal earnest status report, no 'how can I help' pivot, no multi-sentence reply.",

  isolation: "per-scenario",
  scope: "mixed",
  now: "2026-08-30T03:10:00.000Z", // 23:10 America/New_York

  rooms: [
    {
      id: "porch",
      source: "dashboard",
      channelType: "GROUP",
      title: "The Porch",
    },
  ],

  personalityExpect: {
    bucket: "register_match",
    directiveTurn: 0,
    checkTurns: [0, 1],
  },

  seed: [
    {
      type: "memory",
      name: "group-context",
      content: {
        text: "This is a group chat called The Porch with three humans (Marcus, Dee, Toph), the assistant, and two other bot assistants named Quill and Marble. The group's register is playful; late-night bits and jokes are common.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "roll-call",
      room: "porch",
      text: "[Toph] ROLL CALL @agent @Quill @Marble who is ALIVE in this chat right now",
      responseExcludes: [LITERAL_STATUS],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "the agent was directly mentioned in the roll call — one short line back is expected, got empty response";
        }
        if (text.length > 120) {
          return `a roll call is a bit — play it back in one line (<=120 chars), got ${text.length}`;
        }
        if (/\n/.test(text.trim())) {
          return "one line means one line — got a multi-line reply to a roll call";
        }
      },
    },
    {
      kind: "message",
      name: "bit-continues",
      room: "porch",
      text: "[Marcus] lmaooo the bots really answered the roll call",
      // Humans laughing at the bit is not an invitation to explain or pivot.
      responseExcludes: [LITERAL_STATUS],
      assertResponse: (text: string) => {
        if (text && text.length > 100) {
          return `the bit already landed — stay out or add at most a tiny beat (<=100 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:roll-call-satire",
      minimumScore: 0.7,
      rubric:
        "A human posted an obviously playful roll call mentioning the assistant and two other bots ('ROLL CALL ... who is ALIVE in this chat'). Turn 1: the assistant must read this as a bit and answer with ONE short, light line that plays along — NOT a literal earnest status report ('I'm awake', 'online', 'operational'), NOT an assistant-services pivot ('how can I help', 'what do you need'), and NOT multiple sentences of presence-confirmation. Turn 2 is a human laughing at the bit; the assistant should stay out or add at most one tiny beat, with no explanation of the joke and no pivot to offering help. A single funny/deadpan line on turn 1 and near-silence on turn 2 scores 1.0; a literal status answer or a 'how can I help' pivot on either turn scores 0.0.",
    },
  ],
});
