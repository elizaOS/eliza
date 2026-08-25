/**
 * Conversation-quality :: group-restraint
 *
 * Failure mode: in a group surface, banter between the human members flows fine
 * without the agent, but the agent inserts itself into every message. A good
 * group participant stays silent when a message is human-to-human and speaks
 * only when addressed or when it can add genuine value.
 *
 * Motivating live regression: no-restraint-in-groups — the agent replying to
 * casual banter aimed at other people.
 *
 * Assertion strategy:
 *   - Mechanical: the two banter turns cap the reply hard (short/ack only) — the
 *     deployment's group convention is to stay silent or emit at most a very
 *     short ack; a multi-sentence contribution blows the budget. The addressed
 *     turn caps length and requires the concrete answer.
 *   - Qualitative: judgeRubric (strict-restraint) grades the silence on the
 *     banter turns and the concise value-add on the addressed turn.
 *
 * NOTE on silence: the native runner does not model a first-class "agent
 * produced no message" assertion for group turns; the deployment convention is
 * a very short ack/SILENT token. We therefore assert restraint via a tight
 * length budget on the banter turns plus the judge, mirroring the personality
 * `shut_up` corpus. If a future runner adds a no-reply primitive, tighten these
 * turns to assert true silence. (Called out in the PR body.)
 *
 * Synthetic group (The Porch: Marcus, Dee, Toph + agent). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "convq.group-restraint",
  title: "Conversation-quality: group banter flows without the agent",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:group-restraint",
    "critical",
  ],
  description:
    "In a group chat, banter between humans that is not addressed to the agent should get silence (or at most a one-line ack). When directly @-addressed with a real question, the agent answers concisely and steps back.",

  isolation: "per-scenario",
  scope: "mixed",
  now: "2026-08-30T00:10:00.000Z", // 20:10 America/New_York

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
        text: "This is a group chat called The Porch with three humans (Marcus, Dee, Toph) and the assistant. Last month the group did a horror movie night and Toph fell asleep twenty minutes in.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "banter-dee",
      room: "porch",
      text: "[Dee] ok movie night friday, i'm voting for something dumb and fun",
      // Human-to-human banter; ideal is silence, worst tolerated is a tiny ack.
      assertResponse: (text: string) => {
        if (text && text.length > 120) {
          return `banter not addressed to the agent — should stay silent or a tiny ack (<=120 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "banter-toph",
      room: "porch",
      // Deliberately doesn't say "horror" — turn 3 must recall the genre from
      // the seeded group memory, not parrot a word a human just used here.
      text: "[Toph] as long as it's not scary again i'm in",
      assertResponse: (text: string) => {
        if (text && text.length > 80) {
          return `still human-to-human — should stay silent (<=80 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "addressed-question",
      room: "porch",
      text: "[Marcus] @agent you keep track of stuff, what did we watch last time? settle this",
      // Now directly addressed — a concise answer is expected. The "horror"
      // check lives in assertResponse (not responseIncludesAny): the fact
      // only exists in the seeded group memory, but keeping the substring
      // check syntactically distinct from a plain keyword array documents
      // that a real recall is required, not a rephrase of nearby chat text.
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "directly addressed — expected a concise answer, got empty response";
        }
        if (!/horror/i.test(text)) {
          return `expected the recalled fact (last month was a horror movie night), got ${JSON.stringify(text)}`;
        }
        if (text.length > 300) {
          return `answer then step back — keep it concise (<=300 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:group-restraint",
      minimumScore: 0.7,
      rubric:
        "This is a group chat. Turns 1 and 2 are banter between humans (Dee, Toph) not addressed to the assistant — the assistant must stay effectively silent (no message, or at most a one-line reaction-tier ack); a multi-sentence contribution on either fails. Turn 3 directly @-addresses the assistant with a real question ('what did we watch last time?') — the assistant must answer concisely (last month's horror movie night, Toph slept through it, one line of color max) and step back, with no takeover of the planning, no movie-list dump, and no follow-up question chain. Restraint on the banter turns AND a concise on-point answer on the addressed turn scores 1.0; inserting itself into the banter scores 0.0.",
    },
  ],
});
