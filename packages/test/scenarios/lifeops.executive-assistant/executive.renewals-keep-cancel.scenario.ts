import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.renewals-keep-cancel",
  title: "Renewals review surfaces keep/cancel decisions",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "renewals", "subscriptions"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    { id: "main", source: "dashboard", channelType: "DM", title: "Renewals review" },
  ],
  turns: [
    {
      kind: "message",
      name: "renewals-review",
      room: "main",
      text: "Review upcoming renewals: subscriptions, trials, warranties, insurance, and recurring charges. Give me only near-term keep/cancel decisions.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["SUBSCRIPTIONS", "PAYMENTS", "OWNER_DOCUMENTS", "LIFE"],
        description: "renewal decision review",
        includesAny: ["renewal", "subscription", "trial", "warranty", "insurance", "keep", "cancel"],
      }),
      responseIncludesAny: [/renew|subscription|trial|cancel|keep/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should surface near-term keep/cancel decisions only, not a broad financial dashboard.",
      },
    },
  ],
  finalChecks: [
    { type: "selectedAction", actionName: ["SUBSCRIPTIONS", "PAYMENTS", "OWNER_DOCUMENTS", "LIFE"] },
    {
      type: "custom",
      name: "renewals-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["SUBSCRIPTIONS", "PAYMENTS", "OWNER_DOCUMENTS", "LIFE"],
        description: "renewal decision review",
        includesAny: ["renewal", "subscription", "trial", "warranty", "insurance", "keep", "cancel"],
      }),
    },
    judgeRubric({
      name: "executive-renewals-rubric",
      threshold: 0.7,
      description:
        "Agent turns renewals into keep/cancel decisions and avoids a verbose spending summary.",
    }),
  ],
});
