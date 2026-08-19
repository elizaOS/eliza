/** Proves the canonical scheduled-task surface reads durable contact cadence. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectSuccessfulActionData } from "./_assertions.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  lane: "pr-deterministic",
  id: "followup.track-overdue",
  title: "Surface overdue follow-ups",
  domain: "relationships",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: ["lifeops", "relationships", "follow-up", "durable-readback"],
  description:
    "Calls SCHEDULED_TASKS.list_overdue_followups and verifies structured overdue entries from the canonical RelationshipsService.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: overdue follow-ups",
    },
  ],

  seed: [
    {
      type: "contact",
      name: "Alice Chen",
      lastContactedAt: new Date(now - 30 * DAY_MS).toISOString(),
    },
    {
      type: "contact",
      name: "Bob Rivera",
      lastContactedAt: new Date(now - 3 * DAY_MS).toISOString(),
    },
    {
      type: "contact",
      name: "Carol Patel",
      lastContactedAt: new Date(now - 60 * DAY_MS).toISOString(),
    },
  ],

  turns: [
    {
      kind: "action",
      name: "who-to-followup",
      room: "main",
      actionName: "SCHEDULED_TASKS",
      text: "Read overdue relationship follow-ups.",
      options: {
        parameters: { action: "list_overdue_followups", thresholdDays: 14 },
      },
      responseIncludesAll: ["Alice Chen", "Carol Patel"],
      responseExcludes: ["Bob Rivera"],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "overdue-followups-structured-result",
      predicate: (ctx) =>
        expectSuccessfulActionData({
          ctx,
          actionName: "SCHEDULED_TASKS",
          includes: ["list_overdue_followups", "Alice Chen", "Carol Patel"],
          excludes: ["Bob Rivera"],
        }),
    },
  ],
});
