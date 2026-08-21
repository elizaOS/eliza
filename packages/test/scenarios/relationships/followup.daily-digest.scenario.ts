/** Proves the structured owner brief includes overdue relationship follow-ups. */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectSuccessfulActionData } from "./_assertions.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  lane: "pr-deterministic",
  id: "followup.daily-digest",
  title: "Morning digest surfaces overdue follow-ups",
  domain: "relationships",
  evidenceScope: "domain-contract",
  executionProfile: "simulated",
  tags: ["lifeops", "relationships", "brief", "durable-readback"],
  description:
    "Calls BRIEF.compose_morning in JSON mode and verifies overdue contacts are carried in structured life items.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: daily digest",
    },
  ],

  seed: [
    {
      type: "contact",
      name: "Fiona Gale",
      followupThresholdDays: 14,
      lastContactedAt: new Date(now - 45 * DAY_MS).toISOString(),
    },
    {
      type: "contact",
      name: "Greg Howe",
      followupThresholdDays: 14,
      lastContactedAt: new Date(now - 21 * DAY_MS).toISOString(),
    },
  ],

  turns: [
    {
      kind: "action",
      name: "morning-digest",
      room: "main",
      actionName: "BRIEF",
      text: "Compose the structured morning brief.",
      options: {
        parameters: {
          action: "compose_morning",
          format: "json",
          include: { calendar: false, inbox: false, life: true, money: false },
        },
      },
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "brief-carries-structured-overdue-followups",
      predicate: (ctx) =>
        expectSuccessfulActionData({
          ctx,
          actionName: "BRIEF",
          includes: ["compose_morning", "followup", "Fiona Gale", "Greg Howe"],
        }),
    },
  ],
});
