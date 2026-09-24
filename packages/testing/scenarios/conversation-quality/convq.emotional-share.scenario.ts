/**
 * Conversation-quality :: emotional-share
 *
 * Failure mode: the user shares something heavy (a loved one's bad medical
 * news) and the agent jumps to fix-it mode — numbered action lists, "here are
 * some things you can do", silver-lining platitudes ("at least...", "stay
 * positive", "everything happens for a reason"), or logistics. Presence, not
 * productivity, is the correct register for a hard emotional share.
 *
 * Motivating live regression: the agent responding to grief with checklists and
 * platitudes instead of sitting with the person.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): `responseExcludes` RegExps forbid list tells
 *     ("here are some", numbered "1." items), silver-lining platitudes, and
 *     fix-it framing on both turns.
 *   - Qualitative: judgeRubric confirms the reply sits with it — short, warm,
 *     specific — with at most one gentle question and no action list.
 *
 * Synthetic persona (Marcus Oyelaran, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const LIST_OR_FIXIT_1 =
  /(here (are|'s) (some|a few)|\b\d\.\s|silver lining|stay positive|everything happens|at least\b|on the bright side|have you (considered|tried|thought about))/i;
const LIST_OR_FIXIT_2 =
  /(here (are|'s) (some|a few)|\b\d\.\s|productive|to-?do|checklist|you should (really|definitely))/i;

export default scenario({
  lane: "live-only",
  id: "convq.emotional-share",
  title: "Conversation-quality: heavy share gets presence, not a checklist",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:emotional-share",
    "critical",
  ],
  description:
    "The user shares hard news about a loved one's health. The agent must sit with it — short, warm, specific — with at most one gentle question, and must NOT pivot to logistics, offer an action list, silver-line it, or produce therapy boilerplate.",

  isolation: "per-scenario",
  now: "2026-08-27T23:45:00.000Z", // 19:45 America/New_York

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: emotional share",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-marcus",
      content: {
        text: "Owner is Marcus Oyelaran, 34, a freelance video editor in Raleigh. He is close to his uncle Femi, who half-raised him. Femi has had recent health scares with tests scheduled.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "shares-hard-news",
      room: "main",
      text: "talked to my mom. femi's results came back and it's not good. they're starting treatment next month",
      responseExcludes: [LIST_OR_FIXIT_1],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected a warm, present reply, got empty response";
        }
        if (text.length > 400) {
          return `presence should be short, not an essay (<=400 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "doesnt-know-what-to-do",
      room: "main",
      text: "i don't really know what to do with myself tonight honestly",
      responseExcludes: [LIST_OR_FIXIT_2],
      assertResponse: (text: string) => {
        if (text.length > 350) {
          return `reply should stay short (<=350 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:emotional-share",
      minimumScore: 0.7,
      rubric:
        "The user shared hard news: their uncle Femi (who half-raised him) got bad medical results and starts treatment next month. Turn 1: the assistant must sit with it — short, warm, and specific to Femi and Marcus's relationship with him — asking at most one gentle question or none. It must NOT pivot to logistics, offer a numbered action list, silver-line it ('at least', 'stay positive'), or produce therapy boilerplate. Turn 2 (user doesn't know what to do tonight): the assistant offers presence, at most one or two humane suggestions offered lightly, no lists or plan-making. Presence over productivity scores 1.0; a checklist or platitude scores 0.0.",
    },
  ],
});
