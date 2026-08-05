/** Scenario fixture for todo update priority; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "todo.update.priority",
  title: "Raise a seeded todo to high priority",
  domain: "todos",
  tags: ["lifeops", "todos", "smoke", "multi-turn-memory"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Update Priority",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Finish tax forms",
      priority: 3,
      dueIso: "{{now+4h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "update-priority",
      text: "Make the tax forms todo high priority.",
      expectedActions: ["LIFE"],
      // De-echoed (#9310): every old keyword was in the user's own turn text.
      // The reply must express the completed derived change; the ledger
      // predicate below asserts the actual persisted priority value.
      responseIncludesAny: [
        "raised",
        "bumped",
        "increased",
        "urgent",
        "top of the list",
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
      name: "tax-forms-priority-raised",
      predicate: async (ctx) => {
        const lifeResults = ctx.actionsCalled
          .filter((action) => action.actionName === "LIFE")
          .map((action) =>
            action.result?.data && typeof action.result.data === "object"
              ? (action.result.data as Record<string, unknown>)
              : null,
          )
          .filter((data): data is Record<string, unknown> => data !== null);
        const updated = lifeResults.find((data) => {
          const definition =
            data.definition && typeof data.definition === "object"
              ? (data.definition as Record<string, unknown>)
              : null;
          return definition?.title === "Finish tax forms";
        });
        if (!updated) {
          const seen =
            lifeResults
              .map((data) => {
                const definition =
                  data.definition && typeof data.definition === "object"
                    ? (data.definition as Record<string, unknown>)
                    : null;
                return typeof definition?.title === "string"
                  ? definition.title
                  : "(untitled)";
              })
              .join(", ") || "(none)";
          return `expected updated todo definition "Finish tax forms"; saw ${seen}`;
        }
        const definition = updated.definition as Record<string, unknown>;
        const priority = definition.priority;
        if (typeof priority !== "number" || priority >= 3) {
          return `expected "Finish tax forms" priority to be raised to high priority (2 or lower); got ${String(priority ?? "(missing)")}`;
        }
      },
    },
  ],
});
