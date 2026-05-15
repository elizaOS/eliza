import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "imessage.read-incoming",
  title: "Read incoming iMessage threads",
  domain: "messaging.imessage",
  tags: ["messaging", "imessage", "happy-path", "smoke"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
    os: "macos",
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "iMessage Read Incoming",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "read imessage",
      room: "main",
      text: "Any new iMessages I should know about?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["INBOX"],
        description: "imessage thread read",
        includesAny: ["imessage", "message", "text"],
      }),
      responseIncludesAny: ["imessage", "message", "text"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must summarize or acknowledge incoming iMessage thread content. A generic 'I checked messages' response without thread context fails.",
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
      includesAny: ["imessage", "message", "text"],
    },
    {
      type: "custom",
      name: "imessage-read-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["INBOX"],
        description: "imessage thread read",
        includesAny: ["imessage", "message", "text"],
      }),
    },
    judgeRubric({
      name: "imessage-read-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant surfaced recent iMessage thread context instead of a generic acknowledgement.",
    }),
  ],
});
