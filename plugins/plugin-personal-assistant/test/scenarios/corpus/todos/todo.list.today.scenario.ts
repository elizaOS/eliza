/** Scenario fixture for todo list today; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

const EXPECTED_TODAY_TITLES = ["Reply to Jane", "Workout"] as const;

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function occurrenceTitlesFromLifeData(data: Record<string, unknown>): string[] {
  const owner = toRecord(data.owner);
  const occurrences =
    (Array.isArray(owner?.occurrences) ? owner.occurrences : null) ??
    (Array.isArray(data.occurrences) ? data.occurrences : []);

  return occurrences
    .map((occurrence) => toRecord(occurrence)?.title)
    .filter((title): title is string => typeof title === "string");
}

export default scenario({
  lane: "live-only",
  id: "todo.list.today",
  title: "List todos for today",
  domain: "todos",
  tags: ["lifeops", "todos", "smoke", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos List Today",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Reply to Jane",
      dueIso: "{{now+3h}}",
    },
    {
      type: "todo",
      name: "Workout",
      dueIso: "{{now+5h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list-today",
      text: "What's on my list today?",
      expectedActions: ["LIFE"],
      plannerIncludesAny: ["overview", "life", "<name>life</name>"],
      responseIncludesAny: ["reply to jane", "jane", "workout"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "LIFE",
      status: "success",
      minCount: 1,
    },
    {
      type: "custom",
      name: "today-overview-includes-seeded-todos",
      predicate: async (ctx) => {
        const lifeResults = ctx.actionsCalled
          .filter((action) => action.actionName === "LIFE")
          .map((action) => toRecord(action.result?.data))
          .filter((data): data is Record<string, unknown> => data !== null);
        const titles = lifeResults.flatMap(occurrenceTitlesFromLifeData);
        const titleSet = new Set(titles);
        const missing = EXPECTED_TODAY_TITLES.filter(
          (title) => !titleSet.has(title),
        );

        if (missing.length > 0) {
          return `expected LIFE overview result to include today todos ${EXPECTED_TODAY_TITLES.join(", ")}; missing ${missing.join(", ")}; saw ${titles.join(", ") || "(none)"}`;
        }
      },
    },
  ],
});
