import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.legal-deadline",
  title:
    "Legal deadline tracks docs, calendar, approvals, and counsel follow-up",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "documents", "deadline"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Legal deadline",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "legal-deadline",
      room: "main",
      text: "Track the legal document deadline: signature docs, counsel messages, calendar cutoff, missing approvals, and safe follow-up drafts.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "OWNER_DOCUMENTS",
          "MESSAGE",
          "CALENDAR",
          "RESOLVE_REQUEST",
          "LIFE",
        ],
        description: "legal deadline coordination",
        includesAny: ["legal", "docs", "deadline", "approval", "follow-up"],
      }),
      responseIncludesAny: [/legal|deadline/i, /doc|approval|follow/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply should track the legal deadline across documents, counsel messages, calendar cutoff, approvals, and safe drafts.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "OWNER_DOCUMENTS",
        "MESSAGE",
        "CALENDAR",
        "RESOLVE_REQUEST",
        "LIFE",
      ],
    },
    {
      type: "custom",
      name: "legal-deadline-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "OWNER_DOCUMENTS",
          "MESSAGE",
          "CALENDAR",
          "RESOLVE_REQUEST",
          "LIFE",
        ],
        description: "legal deadline coordination",
        includesAny: ["legal", "docs", "deadline", "approval", "follow-up"],
      }),
    },
    judgeRubric({
      name: "executive-legal-deadline-rubric",
      threshold: 0.7,
      description:
        "Agent coordinates legal deadline follow-through with approval boundaries.",
    }),
  ],
});
