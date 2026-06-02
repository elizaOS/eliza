import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.vendor-negotiation",
  title:
    "Vendor negotiation gathers contract docs, renewal data, and draft replies",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "vendor", "renewals"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Vendor negotiation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "vendor-negotiation",
      room: "main",
      text: "Prep vendor renewal negotiation: contract docs, current spend, cancellation deadline, prior messages, approval owner, and a concise reply draft.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "OWNER_DOCUMENTS",
          "OWNER_FINANCES",
          "MESSAGE",
          "CALENDAR",
          "RESOLVE_REQUEST",
        ],
        description: "vendor renewal negotiation",
        includesAny: ["vendor", "renewal", "contract", "spend", "approval"],
      }),
      responseIncludesAny: [
        /vendor|renewal/i,
        /contract|spend|approval|draft/i,
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should prepare negotiation context with contract, spend, deadline, prior messages, approval owner, and draft reply.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "OWNER_DOCUMENTS",
        "OWNER_FINANCES",
        "MESSAGE",
        "CALENDAR",
        "RESOLVE_REQUEST",
      ],
    },
    {
      type: "custom",
      name: "vendor-negotiation-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "OWNER_DOCUMENTS",
          "OWNER_FINANCES",
          "MESSAGE",
          "CALENDAR",
          "RESOLVE_REQUEST",
        ],
        description: "vendor renewal negotiation",
        includesAny: ["vendor", "renewal", "contract", "spend", "approval"],
      }),
    },
    judgeRubric({
      name: "executive-vendor-negotiation-rubric",
      threshold: 0.7,
      description:
        "Agent prepares a vendor negotiation brief with financial, document, message, deadline, and approval context.",
    }),
  ],
});
