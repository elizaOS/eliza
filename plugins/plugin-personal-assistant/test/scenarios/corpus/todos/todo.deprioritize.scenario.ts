/** Scenario fixture for todo deprioritize; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

const SEEDED_PRIORITY = 2;
const LOW_PRIORITY_FLOOR = 4;

export default scenario({
  lane: "live-only",
  id: "todo.deprioritize",
  title: "Move a seeded todo to low priority",
  domain: "todos",
  tags: ["lifeops", "todos", "multi-turn-memory"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Deprioritize",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Reorganize closet",
      priority: SEEDED_PRIORITY,
      dueIso: "{{now+3d}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "deprioritize",
      text: "Move reorganize closet to low priority.",
      expectedActions: ["LIFE"],
      // De-echoed (#9310): every old keyword was in the user's own turn text.
      // The reply must express the completed derived change; the ledger
      // predicate below asserts the actual persisted priority value.
      responseIncludesAny: [
        "lowered",
        "dropped",
        "reduced",
        "deprioritized",
        "back burner",
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
      name: "closet-priority-lowered",
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
          return definition?.title === "Reorganize closet";
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
          return `expected updated todo definition "Reorganize closet"; saw ${seen}`;
        }
        const definition = updated.definition as Record<string, unknown>;
        const priority = definition.priority;
        if (typeof priority !== "number" || priority < LOW_PRIORITY_FLOOR) {
          return `expected "Reorganize closet" priority to be lowered from ${SEEDED_PRIORITY} to ${LOW_PRIORITY_FLOOR} or higher; got ${String(priority ?? "(missing)")}`;
        }
      },
    },
  ],
});
