/** Proves CONTACT returns structured cadence progress for a durable goal. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectSuccessfulActionData } from "./_assertions.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();
const CONTACT_NAME = "Nora Delgado";

export default scenario({
  lane: "pr-deterministic",
  id: "relationships.status-goals.progress",
  title: "Report quarterly relationship-goal progress",
  domain: "relationships",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: ["lifeops", "relationships", "follow-up", "cadence"],
  description:
    "Calls CONTACT.progress and verifies the structured overdue status, goal, and 90-day cadence from RelationshipsService.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: goal progress",
    },
  ],

  seed: [
    {
      type: "contact",
      name: CONTACT_NAME,
      relationshipGoal: "stay in touch quarterly",
      followupThresholdDays: 90,
      lastContactedAt: new Date(now - 100 * DAY_MS).toISOString(),
    },
  ],

  turns: [
    {
      kind: "action",
      name: "progress-query",
      room: "main",
      actionName: "CONTACT",
      text: "Read Nora's relationship-goal progress.",
      options: {
        parameters: { action: "progress", name: CONTACT_NAME },
      },
      responseIncludesAll: ["overdue"],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "relationship-progress-structured-result",
      predicate: (ctx) =>
        expectSuccessfulActionData({
          ctx,
          actionName: "CONTACT",
          includes: ["progress", "stay in touch quarterly", "90", "overdue"],
        }),
    },
  ],
});
