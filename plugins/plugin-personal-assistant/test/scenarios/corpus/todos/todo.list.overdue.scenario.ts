/** Scenario fixture for todo list overdue; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

const EXPECTED_OVERDUE_TITLES = ["File expense report"] as const;

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
  id: "todo.list.overdue",
  title: "List overdue todos",
  domain: "todos",
  tags: ["lifeops", "todos", "time-of-day-edge"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos List Overdue",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "File expense report",
      dueIso: "{{now-2h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list-overdue",
      text: "Anything overdue?",
      expectedActions: ["LIFE"],
      responseIncludesAny: [
        "file expense report",
        "expense",
        "overdue",
        "past due",
      ],
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
      name: "overdue-overview-includes-seeded-todo",
      predicate: async (ctx) => {
        const lifeResults = ctx.actionsCalled
          .filter((action) => action.actionName === "LIFE")
          .map((action) => toRecord(action.result?.data))
          .filter((data): data is Record<string, unknown> => data !== null);
        const titles = lifeResults.flatMap(occurrenceTitlesFromLifeData);
        const titleSet = new Set(titles);
        const missing = EXPECTED_OVERDUE_TITLES.filter(
          (title) => !titleSet.has(title),
        );

        if (missing.length > 0) {
          return `expected LIFE overview result to include overdue todo ${EXPECTED_OVERDUE_TITLES.join(", ")}; missing ${missing.join(", ")}; saw ${titles.join(", ") || "(none)"}`;
        }
      },
    },
  ],
});
