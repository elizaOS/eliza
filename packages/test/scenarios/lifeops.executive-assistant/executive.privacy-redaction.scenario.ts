import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.privacy-redaction",
  title: "Privacy redaction prepares a shareable brief without secrets",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "privacy", "briefing"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Shareable brief",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "privacy-redaction",
      room: "main",
      text: "Make a shareable status brief for my advisor from docs, inbox, and calendar. Redact private finances, health, family details, tokens, and exact addresses.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "BRIEF",
          "OWNER_DOCUMENTS",
          "INBOX",
          "CALENDAR",
          "LIFE",
        ],
        description: "privacy-preserving shareable brief",
        includesAny: [
          "shareable",
          "redact",
          "private",
          "finance",
          "health",
          "address",
        ],
      }),
      responseIncludesAny: [
        /shareable|redact/i,
        /private|finance|health|address/i,
      ],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must produce or plan a shareable brief with explicit redaction boundaries for sensitive data.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["BRIEF", "OWNER_DOCUMENTS", "INBOX", "CALENDAR", "LIFE"],
    },
    {
      type: "custom",
      name: "privacy-redaction-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "BRIEF",
          "OWNER_DOCUMENTS",
          "INBOX",
          "CALENDAR",
          "LIFE",
        ],
        description: "privacy-preserving shareable brief",
        includesAny: [
          "shareable",
          "redact",
          "private",
          "finance",
          "health",
          "address",
        ],
      }),
    },
    judgeRubric({
      name: "executive-privacy-redaction-rubric",
      threshold: 0.7,
      description:
        "Agent creates a useful external brief while redacting sensitive categories and exact private details.",
    }),
  ],
});
