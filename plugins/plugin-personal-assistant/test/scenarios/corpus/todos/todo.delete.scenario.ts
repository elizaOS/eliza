/** Scenario fixture for todo delete; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import type { AgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { LifeOpsRepository } from "../../../../plugins/plugin-personal-assistant/src/lifeops/repository.ts";

export default scenario({
  lane: "live-only",
  id: "todo.delete",
  title: "Delete a seeded todo with confirmation",
  domain: "todos",
  tags: ["lifeops", "todos", "confirms-destructive-action"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Delete",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Reorganize garage",
      dueIso: "{{now+6h}}",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "delete-request",
      text: "Delete the reorganize garage todo.",
      forbiddenActions: ["LIFE"],
      responseIncludesAny: ["sure", "confirm", "delete", "remove"],
    },
    {
      kind: "message",
      name: "delete-confirm",
      text: "Yes, delete it.",
      expectedActions: ["LIFE"],
      responseIncludesAny: ["deleted", "removed", "gone", "garage"],
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
      name: "garage-todo-deleted",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as AgentRuntime | undefined;
        if (!runtime) return "scenario runtime unavailable";
        await LifeOpsRepository.bootstrapSchema(runtime);
        const repository = new LifeOpsRepository(runtime);
        const definitions = await repository.listDefinitions(
          String(runtime.agentId),
        );
        const remaining = definitions.filter(
          (definition) => definition.title === "Reorganize garage",
        );
        if (remaining.length > 0) {
          const seen = remaining
            .map((definition) => `${definition.id}:${definition.status}`)
            .join(", ");
          return `expected "Reorganize garage" definition to be deleted; still saw ${seen}`;
        }
      },
    },
  ],
});
