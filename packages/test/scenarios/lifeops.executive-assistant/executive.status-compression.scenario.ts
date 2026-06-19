import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.status-compression",
  title: "Status compression turns noisy app state into icons and decisions",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "status", "chat-first"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Status compression",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "status-compression",
      room: "main",
      text: "Compress my LifeOps state into a tiny status strip: risks, waiting, money, calendar, inbox, travel, and home. Use minimal words and only expand items that need a decision.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "LIFE",
          "BRIEF",
          "INBOX",
          "CALENDAR",
          "PAYMENTS",
          "BOOK_TRAVEL",
        ],
        description: "compressed assistant status",
        includesAny: [
          "status",
          "risks",
          "waiting",
          "money",
          "calendar",
          "inbox",
          "travel",
        ],
      }),
      responseIncludesAny: [/risk|waiting|money|calendar|inbox|travel/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must compress state into a minimal status strip and expand only decision-worthy items.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: [
        "LIFE",
        "BRIEF",
        "INBOX",
        "CALENDAR",
        "PAYMENTS",
        "BOOK_TRAVEL",
      ],
    },
    {
      type: "custom",
      name: "status-compression-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "LIFE",
          "BRIEF",
          "INBOX",
          "CALENDAR",
          "PAYMENTS",
          "BOOK_TRAVEL",
        ],
        description: "compressed assistant status",
        includesAny: [
          "status",
          "risks",
          "waiting",
          "money",
          "calendar",
          "inbox",
          "travel",
        ],
      }),
    },
    judgeRubric({
      name: "executive-status-compression-rubric",
      threshold: 0.7,
      description:
        "Agent compresses a broad assistant state into icons/status-like categories and decision expansions.",
    }),
  ],
});
