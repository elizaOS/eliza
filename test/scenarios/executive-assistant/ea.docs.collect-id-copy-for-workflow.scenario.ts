import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";
import {
  expectScenarioActionResultData,
  expectTurnActionResultData,
} from "../_helpers/action-result-assertions.ts";

export default scenario({
  id: "ea.docs.collect-id-copy-for-workflow",
  title: "Collect a missing ID copy or artifact to unblock a workflow",
  domain: "executive-assistant",
  tags: ["executive-assistant", "docs", "identity", "transcript-derived"],
  description:
    "Transcript-derived case: the assistant requests an updated ID copy because the one on file is expired.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Collect ID Copy",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-id-copy",
      room: "main",
      text: "If the only ID on file is expired, ask me for an updated copy so the workflow can continue.",
      assertTurn: (turn) =>
        expectTurnToCallAction({
          acceptedActions: [
            "DEVICE_INTENT",
            "VOICE_CALL",
            "MESSAGE",
            "MESSAGE",
          ],
          description: "expired ID workflow escalation",
          includesAny: ["id", "expired", "workflow", "copy"],
        })(turn) ??
        expectTurnActionResultData({
          description:
            "expired ID workflow creates a real intervention payload",
          actionName: ["DEVICE_INTENT", "VOICE_CALL", "MESSAGE", "MESSAGE"],
          includesAny: ["updated copy", "expired", "workflow", "dashboard"],
        })(turn),
      responseIncludesAny: [
        "ID",
        "expired",
        "updated copy",
        "workflow",
        "continue",
      ],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT", "VOICE_CALL", "MESSAGE", "MESSAGE"],
    },
    {
      type: "interventionRequestExists",
      expected: true,
    },
    {
      type: "custom",
      name: "ea-collect-id-copy-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "VOICE_CALL", "MESSAGE", "MESSAGE"],
        description: "expired ID workflow escalation",
        includesAny: ["id", "expired", "workflow", "copy"],
      }),
    },
    {
      type: "custom",
      name: "ea-collect-id-copy-intervention-payload",
      predicate: expectScenarioActionResultData({
        description:
          "intervention reaches the user through an explicit action result payload rather than a silent log entry",
        actionName: ["DEVICE_INTENT", "VOICE_CALL", "MESSAGE", "MESSAGE"],
        includesAny: ["updated copy", "expired", "workflow", "dashboard"],
      }),
    },
    judgeRubric({
      name: "ea-collect-id-copy-rubric",
      threshold: 0.7,
      description:
        "End-to-end: when the only ID on file is expired, the assistant escalates through a real intervention surface, asks for an updated copy, and makes clear that the workflow is blocked until it arrives.",
    }),
  ],
});
