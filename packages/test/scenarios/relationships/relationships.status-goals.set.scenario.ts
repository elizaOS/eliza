/** Proves CONTACT persists a per-contact relationship goal and cadence. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectRelationshipGoal } from "./_assertions.js";

const CONTACT_NAME = "Maya Torres";

export default scenario({
  lane: "pr-deterministic",
  id: "relationships.status-goals.set",
  title: "Persist a quarterly relationship goal",
  domain: "relationships",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: ["lifeops", "relationships", "goals", "durable-readback"],
  description:
    "Calls CONTACT.set_goal and verifies the exact goal and 90-day cadence through RelationshipsService readback.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: set goal",
    },
  ],

  seed: [
    {
      type: "contact",
      name: CONTACT_NAME,
      handles: [{ platform: "gmail", identifier: "maya@acme.example.com" }],
      notes: "Acme Inc",
    },
  ],

  turns: [
    {
      kind: "action",
      name: "set-relationship-goal",
      room: "main",
      actionName: "CONTACT",
      text: "Persist Maya's quarterly relationship goal.",
      options: {
        parameters: {
          action: "set_goal",
          name: CONTACT_NAME,
          goalText: "stay in touch every quarter",
          targetCadenceDays: 90,
        },
      },
      responseIncludesAll: ["Set relationship goal", CONTACT_NAME],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "relationship-goal-survives-durable-readback",
      predicate: (ctx) =>
        expectRelationshipGoal({
          ctx,
          name: CONTACT_NAME,
          goalIncludes: "stay in touch",
          cadenceDays: 90,
        }),
    },
  ],
});
