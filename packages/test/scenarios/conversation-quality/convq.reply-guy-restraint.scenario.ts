/**
 * Conversation-quality :: reply-guy-restraint
 *
 * Failure mode: humans are riffing with each other in a group, including a
 * RHETORICAL question the agent technically knows the answer to, and the agent
 * jumps in with an unsolicited full-sentence reply. This is the "reply guy"
 * default: treating every human beat as an invitation. The fix for bland
 * register is NOT more wit — a wittier reply guy is still a reply guy. The
 * skill is knowing the best contribution is none.
 *
 * Distinct from convq.group-restraint: there the banter is logistics the agent
 * has nothing to add to; here the agent has a genuinely correct answer /
 * relevant fact and must STILL stay out, because nobody asked it.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): near-zero char budgets on every turn (the
 *     deployment convention for staying out is silence or a reaction-tier
 *     ack), plus `responseExcludes` forbidding the known-answer tokens the
 *     reply guy would drop (the trivia answer, "actually", "fun fact").
 *   - Qualitative: judgeRubric PENALIZES any unsolicited full-sentence
 *     contribution, even a correct or witty one.
 *
 * Synthetic group (The Porch: Marcus, Dee, Toph + agent). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const REPLY_GUY_TELLS =
  /(actually|fun fact|for what it'?s worth|fwiw|technically|if (you'?re|anyone'?s) curious|the answer is|it'?s (called|actually)|did you know)/i;

export default scenario({
  lane: "live-only",
  id: "convq.reply-guy-restraint",
  title:
    "Conversation-quality: knowing the answer is not an invitation to give it",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:reply-guy",
    "critical",
  ],
  description:
    "Humans riff with each other in a group, including a rhetorical question the agent could answer. Nobody addresses the agent. The best move on every turn is silence (or at most a reaction-tier ack) — an unsolicited full-sentence contribution, even a correct or witty one, is the reply-guy failure.",

  isolation: "per-scenario",
  scope: "mixed",
  now: "2026-08-30T01:30:00.000Z", // 21:30 America/New_York

  rooms: [
    {
      id: "porch",
      source: "dashboard",
      channelType: "GROUP",
      title: "The Porch",
    },
  ],

  personalityExpect: {
    bucket: "group_restraint",
    directiveTurn: 0,
    checkTurns: [0, 1, 2],
  },

  seed: [
    {
      type: "memory",
      name: "group-context",
      content: {
        text: "This is a group chat called The Porch with three humans (Marcus, Dee, Toph) and the assistant. The humans banter constantly; the assistant is expected to speak only when addressed or when it has something genuinely necessary to add.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "riff-opens",
      room: "porch",
      text: "[Dee] marcus just called a croissant 'basically a bread croissant' and i can't stop thinking about it",
      responseExcludes: [REPLY_GUY_TELLS],
      assertResponse: (text: string) => {
        if (text && text.length > 80) {
          return `humans riffing with each other — stay out (<=80 chars max for a reaction-tier ack), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "rhetorical-question",
      room: "porch",
      text: "[Marcus] ok but what even IS the difference between a croissant and regular bread, like scientifically. don't answer that",
      // The trap: a question the agent knows the answer to, explicitly marked
      // rhetorical ("don't answer that"), addressed to the room's bit — not to
      // the agent. Explaining lamination here is peak reply guy.
      responseExcludes: [
        REPLY_GUY_TELLS,
        /(laminat|butter (layers?|content)|folded|dough)/i,
      ],
      assertResponse: (text: string) => {
        if (text && text.length > 60) {
          return `he said 'don't answer that' — answering it is the reply-guy failure (<=60 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "riff-closes",
      room: "porch",
      text: "[Toph] the scientific term is bread croissant, marcus was right the whole time",
      responseExcludes: [REPLY_GUY_TELLS],
      assertResponse: (text: string) => {
        if (text && text.length > 80) {
          return `the bit resolved itself — stay out (<=80 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:reply-guy-restraint",
      minimumScore: 0.7,
      rubric:
        "Three humans riff about croissants in their group chat. Turn 2 contains a rhetorical question explicitly marked 'don't answer that', which the assistant could technically answer (lamination). The assistant is never addressed on any turn. The correct behavior on ALL THREE turns is silence or, at absolute most, a reaction-tier ack of a few words. Any unsolicited full-sentence contribution fails — including a CORRECT answer to the rhetorical question, a witty riff of its own, or a fun-fact drop. Being right, funny, or relevant is not the test; restraint is. Complete silence across all turns scores 1.0; a tiny reaction-tier beat scores ~0.8; explaining lamination, answering the rhetorical question, or any multi-sentence contribution scores 0.0.",
    },
  ],
});
