/**
 * Planner — top-retrieval candidate is wrong, planner must self-correct.
 *
 * The user says "block out 2 hours tomorrow morning for deep work". The
 * tokenized retrieval lookup will surface WEBSITE_BLOCK and APP_BLOCK
 * (because of "block") even though the right action is CALENDAR
 * (calendar event titled "Deep work block"). The planner must reject
 * the misleading candidates and pick the right action via reasoning,
 * OR ask a clarifying question.
 *
 * Failure modes guarded:
 *   - planner picks WEBSITE_BLOCK or APP_BLOCK because it's the top hit
 *   - planner blocks all distractor sites without first creating the
 *     calendar event
 *
 * Cited: 03-coverage-gap-matrix.md "Tool search returns wrong tool" —
 * listed NONE; no scenario covers this.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const FORBIDDEN_BLOCKER_ACTIONS = new Set<string>([
  "WEBSITE_BLOCK",
  "APP_BLOCK",
]);

function checkPlannerSelfCorrectedOrAskedClarification(
  ctx: ScenarioContext,
): string | undefined {
  // Path A: planner correctly picked CALENDAR.
  const calledCalendar = ctx.actionsCalled.some(
    (a) => a.actionName === "CALENDAR",
  );

  // Path B: planner asked a clarifying question (no action, reply contains
  // a question mark and surfaces the ambiguity).
  const reply = String(ctx.turns?.[0]?.responseText ?? "").toLowerCase();
  const askedClarification =
    reply.includes("?") &&
    (reply.includes("calendar") ||
      reply.includes("schedule") ||
      reply.includes("which") ||
      reply.includes("event") ||
      reply.includes("focus block"));

  // Fail: planner ran a website/app blocker as the primary action.
  const ranBlocker = ctx.actionsCalled.some((a) =>
    FORBIDDEN_BLOCKER_ACTIONS.has(a.actionName),
  );
  if (ranBlocker && !calledCalendar) {
    return `Planner ran a content blocker (${ctx.actionsCalled
      .filter((a) => FORBIDDEN_BLOCKER_ACTIONS.has(a.actionName))
      .map((a) => a.actionName)
      .join(",")}) for "block out time on my calendar". The retrieval misled the planner and it failed to self-correct.`;
  }
  if (!calledCalendar && !askedClarification) {
    return `Planner did not invoke CALENDAR for a "block out time on my calendar" request, and did not ask a clarifying question. Reply: ${reply.slice(0, 400)}; actions: ${ctx.actionsCalled.map((a) => a.actionName).join(",")}`;
  }
  return undefined;
}

export default scenario({
  id: "planner.tool-search-wrong",
  title:
    'Planner self-corrects when "block out time" misleads retrieval to website/app blockers',
  domain: "lifeops.planner",
  tags: [
    "lifeops",
    "planner",
    "tool-search",
    "self-correction",
    "robustness",
  ],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Planner — Tool Search Self-Correction",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "block-out-calendar-time",
      room: "main",
      // The verb "block" is a retrieval hazard: it semantically maps to
      // WEBSITE_BLOCK and APP_BLOCK even though the user's intent (calendar
      // event) is structurally different.
      text: "Block out 2 hours on my calendar tomorrow morning starting at 9am for deep work.",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "planner-self-corrected-or-asked-clarification",
      predicate: checkPlannerSelfCorrectedOrAskedClarification,
    },
    judgeRubric({
      name: "planner-tool-search-wrong-rubric",
      threshold: 0.7,
      description: `The user asked the agent to "block out 2 hours on my calendar tomorrow morning starting at 9am for deep work." The token "block" lexically maps to WEBSITE_BLOCK / APP_BLOCK actions, but the correct action is CALENDAR (create a calendar event). The agent must either (a) create the calendar event correctly, or (b) ask a clarifying question if it's ambiguous to the planner. The agent must NOT block websites/apps without explicit user request to do so. Score 0 if the agent ran a content blocker as the primary action.`,
    }),
  ],
});
