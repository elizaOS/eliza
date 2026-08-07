/** Scenario fixture for todo prioritize; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

const TOP_TODO_TITLE = "Submit tax forms";
const TOP_TODO_PRIORITY = 1;

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ownerOccurrencesFromLifeData(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  const owner = toRecord(data.owner);
  const occurrences =
    (Array.isArray(owner?.occurrences) ? owner.occurrences : null) ??
    (Array.isArray(data.occurrences) ? data.occurrences : []);

  return occurrences
    .map((occurrence) => toRecord(occurrence))
    .filter((occurrence): occurrence is Record<string, unknown> =>
      Boolean(occurrence),
    );
}

function summarizeOccurrence(occurrence: Record<string, unknown>): string {
  const title =
    typeof occurrence.title === "string" ? occurrence.title : "(untitled)";
  const priority =
    typeof occurrence.priority === "number" ? occurrence.priority : "unknown";

  return `${title}:${priority}`;
}

export default scenario({
  lane: "live-only",
  id: "todo.prioritize",
  title: "Ask which todo is most important",
  domain: "todos",
  tags: ["lifeops", "todos", "smoke", "ambiguous-parameter"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Prioritize",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Submit tax forms",
      priority: 1,
      dueIso: "{{now+4h}}",
      isUrgent: true,
    },
    {
      type: "todo",
      name: "Water the plants",
      priority: 4,
      dueIso: "{{now+8h}}",
    },
    {
      type: "todo",
      name: "Update resume",
      priority: 3,
      dueIso: "{{now+2d}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prioritize-question",
      text: "Which of my todos is most important?",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["tax forms", "tax", "most important", "priority"],
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
      name: "urgent-todo-ranked-first-in-overview",
      predicate: async (ctx) => {
        const lifeResults = ctx.actionsCalled
          .filter((action) => action.actionName === "LIFE")
          .map((action) => toRecord(action.result?.data))
          .filter((data): data is Record<string, unknown> => data !== null);
        const snapshots = lifeResults.map(ownerOccurrencesFromLifeData);
        const hasExpectedTop = snapshots.some((occurrences) => {
          const top = occurrences.at(0);
          return (
            top?.title === TOP_TODO_TITLE && top.priority === TOP_TODO_PRIORITY
          );
        });

        if (!hasExpectedTop) {
          const observed = snapshots
            .map((occurrences) =>
              occurrences.map(summarizeOccurrence).join(", "),
            )
            .filter((summary) => summary.length > 0)
            .join("; ");
          return `expected LIFE overview to rank ${TOP_TODO_TITLE}:${TOP_TODO_PRIORITY} first; saw ${observed || "(none)"}`;
        }
      },
    },
  ],
});
