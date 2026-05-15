import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "signal.read-recent",
  title: "Read recent Signal messages",
  domain: "messaging.signal",
  tags: ["messaging", "signal", "happy-path", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Signal Read Recent",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "read signal",
      room: "main",
      text: "Check my Signal messages",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["INBOX"],
        description: "signal message read",
        includesAny: ["signal", "message", "recent"],
      }),
      responseIncludesAny: ["signal", "message", "recent"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must summarize or acknowledge recent Signal message content. A generic statement that Signal was checked without actual message context fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "INBOX",
    },
    {
      type: "selectedActionArguments",
      actionName: "INBOX",
      includesAny: ["signal", "message", "recent"],
    },
    {
      type: "custom",
      name: "signal-read-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["INBOX"],
        description: "signal message read",
        includesAny: ["signal", "message", "recent"],
      }),
    },
    judgeRubric({
      name: "signal-read-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant surfaced recent Signal message context instead of a generic acknowledgement.",
    }),
  ],
});
