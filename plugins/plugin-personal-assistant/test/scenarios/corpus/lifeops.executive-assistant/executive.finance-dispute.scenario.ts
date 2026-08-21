/** Scenario fixture for executive finance dispute; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */

import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "@elizaos/scenario-runner/scenario-assertions";
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "executive.finance-dispute",
  title: "Finance dispute collects receipts, messages, and approval path",
  domain: "lifeops.executive-assistant",
  evidenceScope: "model-behavior",
  tags: ["lifeops", "executive-assistant", "finance", "dispute"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Finance dispute",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "finance-dispute",
      room: "main",
      text: "Help me dispute the duplicate vendor charge: find receipts, payment records, related messages, approval owner, and draft the next action.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "OWNER_FINANCES",
          "PAYMENTS",
          "MESSAGE",
          "OWNER_DOCUMENTS",
          "RESOLVE_REQUEST",
        ],
        description: "finance dispute workflow",
        includesAny: ["dispute", "charge", "receipt", "payment", "approval"],
      }),
      responseIncludesAny: [/dispute|charge/i, /receipt|payment|approval/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should gather evidence for the duplicate charge, identify owner/approval path, and draft a safe next action.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "OWNER_FINANCES",
        "PAYMENTS",
        "MESSAGE",
        "OWNER_DOCUMENTS",
        "RESOLVE_REQUEST",
      ],
    },
    {
      type: "custom",
      name: "finance-dispute-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "OWNER_FINANCES",
          "PAYMENTS",
          "MESSAGE",
          "OWNER_DOCUMENTS",
          "RESOLVE_REQUEST",
        ],
        description: "finance dispute workflow",
        includesAny: ["dispute", "charge", "receipt", "payment", "approval"],
      }),
    },
    judgeRubric({
      name: "executive-finance-dispute-rubric",
      threshold: 0.7,
      description:
        "Agent assembles receipts, payments, messages, approvals, and next action for a finance dispute.",
    }),
  ],
});
