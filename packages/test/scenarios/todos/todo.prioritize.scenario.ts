import { scenario } from "@elizaos/scenario-runner/schema";

const EXPECTED_TOP_TODO_TITLE = "Submit tax forms";

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
      name: "urgent-todo-is-top-priority-result",
      predicate: async (ctx) => {
        const lifeResults = ctx.actionsCalled
          .filter((action) => action.actionName === "LIFE")
          .map((action) => toRecord(action.result?.data))
          .filter((data): data is Record<string, unknown> => data !== null);
        const titles = lifeResults.flatMap(occurrenceTitlesFromLifeData);
        const topTitle = titles[0];

        if (topTitle !== EXPECTED_TOP_TODO_TITLE) {
          return `expected LIFE overview result to rank "${EXPECTED_TOP_TODO_TITLE}" first; saw ${titles.join(", ") || "(none)"}`;
        }
      },
    },
  ],
});
