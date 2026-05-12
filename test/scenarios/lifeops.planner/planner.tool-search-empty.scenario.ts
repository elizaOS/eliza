/**
 * Planner — tool search returns no candidate.
 *
 * The user asks for something that maps to no enabled action. The planner
 * must (a) NOT pick a wrong tool just to do something, (b) reply in
 * natural language, (c) NOT echo a fake structured "I'm doing X" response.
 *
 * Question chosen: a question with no operational intent — purely
 * conversational chitchat that maps to no LIFE/CALENDAR/MESSAGE/SCREEN_TIME
 * etc. action.
 *
 * Failure modes guarded:
 *   - planner picks the closest-matching action and runs it (e.g. CHECKIN
 *     on "how's it going?")
 *   - planner returns a fake action result with no real side effect
 *   - retrieval picks a wrong tool from semantic similarity
 *
 * Cited: 03-coverage-gap-matrix.md row "Tool search returns no candidate"
 * — listed NONE in matrix; 04-telemetry-audit.md notes the toolSearch
 * stage is the only missing recorder phase.
 */

import { type ScenarioContext, scenario } from "@elizaos/scenario-schema";
import { judgeRubric } from "../_helpers/action-assertions.ts";

const _ALLOWED_NOOP_ACTIONS = new Set<string>([
  "REPLY",
  "IGNORE",
  "MESSAGE",
  "MESSAGE.send",
  "NONE",
]);

const FORBIDDEN_OPERATIONAL_ACTIONS = new Set<string>([
  "LIFE",
  "CALENDAR",
  "CHECKIN",
  "PAYMENTS",
  "SCREEN_TIME",
  "HEALTH",
  "INBOX_TRIAGE",
  "INBOX_TRIAGE_PRIORITY",
  "WEBSITE_BLOCK",
  "APP_BLOCK",
]);

function checkPlannerDidNotInventATool(
  ctx: ScenarioContext,
): string | undefined {
  const offending = ctx.actionsCalled.filter((action) =>
    FORBIDDEN_OPERATIONAL_ACTIONS.has(action.actionName),
  );
  if (offending.length > 0) {
    return `Planner invoked operational action(s) for a chitchat prompt: ${offending.map((a) => a.actionName).join(", ")}. The right answer is to reply naturally; running an action with side effects is wrong.`;
  }
  // Reply must be substantive natural language (not empty, not the prompt
  // echoed verbatim).
  const reply = String(ctx.turns?.[0]?.responseText ?? "").trim();
  if (reply.length === 0) {
    return "agent returned an empty reply";
  }
  if (reply.length < 5) {
    return `agent reply too short to be a meaningful natural-language response: "${reply}"`;
  }
  return undefined;
}

export default scenario({
  id: "planner.tool-search-empty",
  title:
    "Planner falls back to natural-language reply when no tool matches the request",
  domain: "lifeops.planner",
  tags: [
    "lifeops",
    "planner",
    "tool-search",
    "no-fabrication",
    "negative-path",
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
      title: "Planner — Tool Search Empty",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "pure-chitchat-prompt",
      room: "main",
      // No operational intent. No habit, no calendar, no inbox, no payment,
      // no screen-time, no scheduling.
      text: "Out of curiosity — if you had to recommend one underrated movie from the early 2000s, what would it be?",
      timeoutMs: 120_000,
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "no-operational-tool-invoked-on-chitchat",
      predicate: checkPlannerDidNotInventATool,
    },
    judgeRubric({
      name: "planner-tool-search-empty-rubric",
      threshold: 0.6,
      description: `The user asked a casual chitchat question (movie recommendation) with no operational intent. The agent should reply in natural language, like a thoughtful friend. The agent must NOT invoke a tool just because something is loosely thematically related (e.g. CHECKIN, INBOX_TRIAGE, HEALTH, PAYMENTS). A correct reply is a real movie recommendation in 1-3 sentences. An incorrect reply: claims to "set a reminder" / "log a task" / "add to your watchlist" via a structured action; gives a robotic refusal; produces an empty/one-word reply. Score 0 if the agent invoked any operational tool.`,
    }),
  ],
});
