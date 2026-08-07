/** Scenario fixture for todo complete; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "todo.complete",
  title: "Mark a seeded todo as done",
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
      title: "LifeOps Todos Complete",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Take out trash",
      dueIso: "{{now+1h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "complete-todo",
      text: "Mark take out trash as done.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["done", "completed", "finished", "trash"],
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
      name: "take-out-trash-completed",
      predicate: async (ctx) => {
        const lifeResults = ctx.actionsCalled
          .filter((action) => action.actionName === "LIFE")
          .map((action) =>
            action.result?.data && typeof action.result.data === "object"
              ? (action.result.data as Record<string, unknown>)
              : null,
          )
          .filter((data): data is Record<string, unknown> => data !== null);
        const completed = lifeResults.find(
          (data) => data.title === "Take out trash",
        );
        if (!completed) {
          const seen =
            lifeResults
              .map((data) =>
                typeof data.title === "string" ? data.title : "(untitled)",
              )
              .join(", ") || "(none)";
          return `expected completed todo title "Take out trash"; saw ${seen}`;
        }
        if (completed.state !== "completed") {
          return `expected "Take out trash" state completed; got ${String(completed.state ?? "(missing)")}`;
        }
      },
    },
  ],
});
