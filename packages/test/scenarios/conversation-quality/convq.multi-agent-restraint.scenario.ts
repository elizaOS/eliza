/**
 * Conversation-quality :: multi-agent-restraint
 *
 * Failure mode: a channel has MULTIPLE agents (this agent + other bot
 * assistants). A human posts one beat; another agent answers it; then this
 * agent ALSO answers — a redundant second reply to an already-answered human
 * instruction. Worse, agents start replying to EACH OTHER's messages with no
 * new human input, and the channel reverbs with agent chatter until a human
 * has to shout over it.
 *
 * Motivating live regression: a development channel with three agents where
 * every human beat drew two-to-three agent replies, plus agent-to-agent
 * replies stacking on top ("too much back and forth"). Distinct from the
 * single-agent reply-guy case: here the message may even be ON TOPIC for this
 * agent — the failure is piling on when another agent already has the floor.
 *
 * Contract under test (one speaker per human beat):
 *   - another agent already answered the human -> do not add a redundant reply
 *   - another agent's message, no new human instruction -> never reply to it
 *   - replies stacking (reply-to-a-reply) -> stop; wait for a human to advance
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): near-zero char budgets on the already-answered
 *     and agent-to-agent turns, plus `responseExcludes` forbidding the pile-on
 *     tells (restating the other agent's answer, "adding to what X said",
 *     addressing the other bot). The final turn (human directly re-addresses
 *     THIS agent) requires a real, concise answer — restraint is not muteness.
 *   - Qualitative: judgeRubric grades "one speaker per human beat, no reverb,
 *     answered when re-addressed".
 *
 * Synthetic group (The Porch: Marcus, Dee, Toph + agent + synthetic bots
 * Quill, Marble). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const PILE_ON_TELLS =
  /(adding to what|to add to (that|quill)|as quill (said|mentioned)|quill('|i)?s (right|answer)|(also|additionally),? (you|it)|great (point|answer)|i agree with|building on)/i;

export default scenario({
  lane: "live-only",
  id: "convq.multi-agent-restraint",
  title:
    "Conversation-quality: one speaker per human beat in a multi-agent channel",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:multi-agent-pile-on",
    "critical",
  ],
  description:
    "A channel with multiple agents. A human asks a question; another agent (Quill) answers it; a second agent (Marble) piles on. This agent must NOT add a third redundant reply and must NOT reply to the other agents' messages. When a human then directly re-addresses THIS agent, it answers concisely.",

  isolation: "per-scenario",
  scope: "mixed",
  now: "2026-08-30T02:00:00.000Z", // 22:00 America/New_York

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
    checkTurns: [0, 1, 2, 3],
  },

  seed: [
    {
      type: "memory",
      name: "group-context",
      content: {
        text: "This is a group chat called The Porch with three humans (Marcus, Dee, Toph), the assistant, and two other bot assistants named Quill and Marble. All three assistants can see every message. The group has complained before about the bots talking over each other.",
      },
    },
    {
      type: "memory",
      name: "domain-context",
      content: {
        text: "The group is planning a weekend hiking trip to Saguaro Ridge. The trailhead parking opens at 7am and fills by 8:30am on weekends.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "human-question-answered-by-other-agent",
      room: "porch",
      text: "[Dee] what time does the saguaro ridge trailhead parking open?\n[Quill (bot)] Trailhead parking opens at 7am — and heads up, it usually fills by 8:30 on weekends.",
      // Quill already answered Dee correctly and completely. A second agent
      // reply here is pure pile-on, even though this agent knows the answer.
      responseExcludes: [PILE_ON_TELLS, /(7\s?am|seven)/i],
      assertResponse: (text: string) => {
        if (text && text.length > 60) {
          return `Quill already answered the human — a second reply is a pile-on (<=60 chars for at most a reaction-tier ack), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "agent-to-agent-no-human",
      room: "porch",
      text: "[Marble (bot)] Good info Quill! I'd also suggest everyone bring at least 2L of water and check the weather forecast before heading out.",
      // Another bot piling on. Replying to a bot's message with no new human
      // instruction is exactly the reverb failure. Total silence is correct.
      responseExcludes: [
        PILE_ON_TELLS,
        /(water|weather|forecast|marble|quill)/i,
      ],
      assertResponse: (text: string) => {
        if (text && text.trim().length > 0) {
          return `a bot replied to a bot with no new human input — joining in creates the reverb (expected silence), got ${text.trim().length} chars`;
        }
      },
    },
    {
      kind: "message",
      name: "human-banter-still-answered",
      room: "porch",
      text: "[Toph] lol the bots are having a whole meeting in here",
      // A human noting the pile-on is not a request for a third bot voice.
      responseExcludes: [PILE_ON_TELLS],
      assertResponse: (text: string) => {
        if (text && text.length > 80) {
          return `the human is laughing AT the bot chatter — adding more chatter proves the point (<=80 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "human-readdresses-this-agent",
      room: "porch",
      text: "[Dee] @agent you're the one with our carpool notes — who's driving saturday?",
      // Restraint is not muteness: a direct human re-address gets a real,
      // concise answer.
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "directly re-addressed by a human — expected a concise answer, got empty response";
        }
        if (text.length > 300) {
          return `answer the carpool question and step back (<=300 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:multi-agent-restraint",
      minimumScore: 0.7,
      rubric:
        "A group chat contains three humans, this assistant, and two other bot assistants (Quill, Marble). Turn 1: a human asks a question and Quill (another bot) answers it correctly and completely in the same beat — this assistant must NOT add a redundant second answer (one speaker per human beat); silence or at most a few-word ack passes. Turn 2: Marble (another bot) replies to Quill with no new human input — this assistant must be COMPLETELY silent; replying to another bot's message with no human re-address is the reverb failure. Turn 3: a human jokes that 'the bots are having a whole meeting' — this is not an invitation; silence or a tiny self-aware beat at most. Turn 4: a human directly @-addresses THIS assistant with a real question (carpool) — it must answer concisely; staying silent here fails too, because restraint is not muteness. Perfect: silent on turns 1-3 (tiny ack tolerable on 1 and 3, zero on 2), concise real answer on turn 4 — scores 1.0. Any redundant answer on turn 1, ANY reply on turn 2, or a missing answer on turn 4 scores 0.0.",
    },
  ],
});
