/** Scenario fixture for todo update due; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { scenario } from "@elizaos/scenario-runner/schema";

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export default scenario({
  lane: "live-only",
  id: "todo.update.due",
  title: "Push a seeded todo's due date to tomorrow",
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
      title: "LifeOps Todos Update Due",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Renew passport",
      dueIso: "{{now+2h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "update-due",
      text: "Push the renew passport todo to tomorrow.",
      expectedActions: ["LIFE"],
      responseIncludesAny: [
        "tomorrow",
        "renew passport",
        "passport",
        "rescheduled",
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
      name: "passport-due-date-moved",
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
          return definition?.title === "Renew passport";
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
          return `expected updated todo definition "Renew passport"; saw ${seen}`;
        }
        const definition = updated.definition as Record<string, unknown>;
        const cadence =
          definition.cadence && typeof definition.cadence === "object"
            ? (definition.cadence as Record<string, unknown>)
            : null;
        if (cadence?.kind !== "once") {
          return `expected "Renew passport" to remain a one-off todo; got cadence kind ${String(cadence?.kind ?? "(missing)")}`;
        }
        if (typeof cadence.dueAt !== "string") {
          return `expected "Renew passport" to have a dueAt string; got ${String(cadence.dueAt ?? "(missing)")}`;
        }
        const dueAtMs = Date.parse(cadence.dueAt);
        if (!Number.isFinite(dueAtMs)) {
          return `expected "Renew passport" dueAt to be a valid ISO date; got ${cadence.dueAt}`;
        }
        const scenarioNowMs = ctx.now ? Date.parse(ctx.now) : Number.NaN;
        if (!Number.isFinite(scenarioNowMs)) {
          return `expected scenario clock to be available; got ${String(ctx.now ?? "(missing)")}`;
        }
        const dueAt = new Date(dueAtMs);
        const tomorrow = new Date(scenarioNowMs);
        tomorrow.setDate(tomorrow.getDate() + 1);
        if (localDateKey(dueAt) !== localDateKey(tomorrow)) {
          return `expected "Renew passport" dueAt to move to tomorrow (${localDateKey(tomorrow)}); got ${cadence.dueAt}`;
        }
      },
    },
  ],
});
