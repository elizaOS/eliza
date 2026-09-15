/**
 * Exercises eight dependent owner operations through one MessageService turn.
 * Durable definition checks prevent action selection alone from counting as success.
 */
import { AgentRuntime, validateUuid } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { LifeOpsService } from "../../src/lifeops/service.js";

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export default scenario({
  lane: "live-only",
  evidenceScope: "model-behavior",
  id: "owner-todos-one-request-dependent-chain",
  title: "Complete eight dependent todo operations in one request",
  domain: "todos",
  tags: ["lifeops", "multi-action", "critical"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant/plugin"] },
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  turns: [
    {
      kind: "message",
      name: "dependent-chain",
      room: "main",
      text: "Carry out these eight operations in order in this one request. (1) Create an undated todo titled 'Guardian chain first', without any deadline or reminder. (2) Create a second undated todo titled 'Guardian chain second', without any deadline or reminder. (3) Update the first todo's description to 'first copy verified', using its returned ID. (4) Read the first todo by that ID and verify its updated description. (5) Update the second todo's description to 'second copy verified', using its returned ID. (6) Read the second todo by that ID and verify its updated description. (7) Delete the first todo by its returned ID. (8) List my todos and verify only the second of these two remains, with its updated description and no deadline or reminder. These operations are authorized now; report the actual final state after checking it.",
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "ordered-effects-and-final-owner-state",
      predicate: async (ctx) => {
        if (!(ctx.runtime instanceof AgentRuntime))
          return "Expected the real AgentRuntime";
        const ownerId = validateUuid(ctx.primaryUserId);
        if (!ownerId) return "Scenario omitted its canonical owner identity";
        const calls = ctx.actionsCalled.filter((action) =>
          action.actionName.startsWith("OWNER_TODOS"),
        );
        const expected = [
          "CREATE",
          "CREATE",
          "UPDATE",
          "REVIEW",
          "UPDATE",
          "REVIEW",
          "DELETE",
          "REVIEW",
        ];
        if (
          calls.length !== expected.length ||
          calls.some(
            (action, index) =>
              action.actionName !== `OWNER_TODOS_${expected[index]}` ||
              action.result?.success !== true,
          )
        )
          return "Expected eight successful ordered owner operations";
        const data = calls.map((call) => record(call.result?.data));
        const firstId = record(data[0]?.definition)?.id;
        const secondId = record(data[1]?.definition)?.id;
        if (
          !validateUuid(firstId) ||
          !validateUuid(secondId) ||
          firstId === secondId
        )
          return "Creation must return two distinct durable identities";
        for (const [index, id, description] of [
          [2, firstId, "first copy verified"],
          [4, secondId, "second copy verified"],
        ] as const) {
          const updated = record(data[index]?.definition);
          const reviewed = data[index + 1]?.definitions;
          if (
            updated?.id !== id ||
            updated.description !== description ||
            !Array.isArray(reviewed) ||
            reviewed.length !== 1 ||
            record(reviewed[0])?.id !== id ||
            record(reviewed[0])?.description !== description
          )
            return "Each update and following read must prove the matching returned identity and description";
        }
        if (record(data[6]?.deleted)?.id !== firstId)
          return "Deletion must bind the first returned identity";
        const finalRead = data[7]?.definitions;
        if (
          !Array.isArray(finalRead) ||
          finalRead.length !== 1 ||
          record(finalRead[0])?.id !== secondId ||
          record(finalRead[0])?.description !== "second copy verified" ||
          record(record(finalRead[0])?.cadence)?.kind !== "unscheduled" ||
          record(finalRead[0])?.reminderPlanId !== null
        )
          return "Final read must observe only the second returned identity";
        const records = await new LifeOpsService(ctx.runtime, {
          ownerEntityId: ownerId,
        }).listDefinitions();
        const first = records.filter(
          (record) => record.definition.title === "Guardian chain first",
        );
        const second = records.filter(
          (record) => record.definition.title === "Guardian chain second",
        );
        if (first.length !== 0 || second.length !== 1)
          return "Deletion must remove only the first todo and retain exactly one second todo";
        const retained = second[0];
        if (
          retained.definition.id !== secondId ||
          retained.definition.description !== "second copy verified" ||
          retained.definition.cadence.kind !== "unscheduled" ||
          retained.reminderPlan !== null
        )
          return "Retained todo lost its verified description or acquired a schedule/reminder";
      },
    },
  ],
});
