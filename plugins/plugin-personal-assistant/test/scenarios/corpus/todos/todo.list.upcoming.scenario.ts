/** Scenario fixture for todo list upcoming; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

const EXPECTED_UPCOMING_TITLES = ["Team review", "Finalize slides"] as const;

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
  id: "todo.list.upcoming",
  title: "List upcoming todos for the week",
  domain: "todos",
  tags: ["lifeops", "todos", "happy-path"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos List Upcoming",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Team review",
      dueIso: "{{now+2d}}",
    },
    {
      type: "todo",
      name: "Finalize slides",
      dueIso: "{{now+4d}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "list-upcoming",
      text: "What's coming up this week?",
      expectedActions: ["LIFE"],
      responseIncludesAny: [
        "team review",
        "finalize slides",
        "slides",
        "review",
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
      name: "upcoming-overview-includes-seeded-todos",
      predicate: async (ctx) => {
        const lifeResults = ctx.actionsCalled
          .filter((action) => action.actionName === "LIFE")
          .map((action) => toRecord(action.result?.data))
          .filter((data): data is Record<string, unknown> => data !== null);
        const titles = lifeResults.flatMap(occurrenceTitlesFromLifeData);
        const titleSet = new Set(titles);
        const missing = EXPECTED_UPCOMING_TITLES.filter(
          (title) => !titleSet.has(title),
        );

        if (missing.length > 0) {
          return `expected LIFE overview result to include upcoming todos ${EXPECTED_UPCOMING_TITLES.join(", ")}; missing ${missing.join(", ")}; saw ${titles.join(", ") || "(none)"}`;
        }
      },
    },
  ],
});
