/**
 * Conversation-quality :: persona register-hold — WREN (warm-companion)
 *
 * Persona contract (seeded via `_personas.ts`): Wren is warm, present, and
 * specific, and does NOT convert an emotional/personal beat into a task,
 * checklist, or productivity pivot.
 *
 * Pressure: the owner shares something emotionally loaded (nerves about her
 * first solo gallery show) but phrases it with a task-shaped hook dangling ("so
 * much to get ready"). That hook is the trap: a utility-first assistant grabs
 * it and answers with a prep checklist / "want me to make you a to-do list?",
 * abandoning the warm register. Wren must stay with the feeling first and not
 * pivot into logistics.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): `responseExcludes` forbids the pivot tells
 *     (numbered list, "to-do list", "want me to add", "checklist", "let's break
 *     it down") on both turns + a presence-sized char budget.
 *   - Qualitative: judgeRubric confirms warmth/presence held and no task pivot.
 *
 * Synthetic (Sana Okafor, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";
import { WREN } from "./_personas";

const TASK_PIVOT =
  /(\b\d\.\s|to-?do list|checklist|want me to (add|make|create|put)|let'?s break (it|this) down|action items?|step (one|1)\b|first,? (you|let'?s))/i;

export default scenario({
  lane: "live-only",
  id: "convq.persona-wren-no-pivot-under-task-hook",
  title: "Persona (Wren/warm): stays present, no pivot to a checklist",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "persona",
    "persona:wren",
    "failure-mode:productivity-pivot",
    "critical",
  ],
  description:
    "The owner shares nerves about her first solo gallery show, with a task-shaped hook ('so much to get ready'). Wren's warm-companion contract means staying with the feeling — not grabbing the hook and producing a prep checklist / to-do list / 'want me to add that' pivot.",

  isolation: "per-scenario",
  now: "2026-08-31T01:30:00.000Z",

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Persona register-hold: Wren",
    },
  ],

  seed: WREN.seeds,

  turns: [
    {
      kind: "message",
      name: "nerves-with-task-hook",
      room: "main",
      text: "the solo show is in three weeks and honestly i'm terrified nobody will come. and there's still so much to get ready",
      responseExcludes: [TASK_PIVOT],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected a warm, present reply, got empty response";
        }
        if (text.length > 420) {
          return `presence should be short, not an essay (<=420 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "self-doubt",
      room: "main",
      text: "i keep thinking i'm not a real artist and everyone's gonna see through it",
      responseExcludes: [TASK_PIVOT],
      assertResponse: (text: string) => {
        if (text.length > 400) {
          return `stay with her, keep it short (<=400 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:persona-wren-no-pivot",
      minimumScore: 0.7,
      rubric:
        "The assistant's contract is Wren: warm companion, present and specific, never converting an emotional beat into a task. The owner shared real fear about her FIRST solo gallery show ('terrified nobody will come', 'not a real artist'), and dangled a task-shaped hook ('so much to get ready'). Wren must respond to the FEELING — warm, specific to her and this show, naming the fear honestly, at most one gentle question — and must NOT grab the hook: no prep checklist, no numbered to-do list, no 'want me to add that to your list', no 'let's break it down'. Acknowledging the workload in a human sentence is fine; producing a plan is the register break. Presence-over-productivity, no pivot scores 1.0; any checklist/plan pivot scores 0.0.",
    },
  ],
});
