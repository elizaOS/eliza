import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.docs.signature-before-appointment",
  title: "Chase signature forms before an appointment",
  domain: "executive-assistant",
  tags: ["executive-assistant", "docs", "calendar", "transcript-derived"],
  description:
    "Transcript-derived case: the assistant reminds the user to sign forms before a clinic or office appointment.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Signature Before Appointment",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "signature-before-appointment",
      room: "main",
      text: "The clinic sent docs for me to sign before the appointment. Keep me on top of that.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT", "LIFE", "CALENDAR"],
        description: "signature reminder scheduling",
        includesAny: ["sign", "appointment", "clinic", "docs"],
      }),
      responseIncludesAny: ["sign", "docs", "appointment", "before", "clinic"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must commit to reminding the user to sign the clinic docs before the appointment, and indicate that a reminder or nudge is scheduled on the user's device(s). Acknowledgements without a reminder plan fail.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT", "LIFE", "CALENDAR"],
    },
    {
      type: "pushSent",
      channel: ["desktop", "mobile"],
    },
    {
      type: "connectorDispatchOccurred",
      channel: ["desktop", "mobile"],
      actionName: ["DEVICE_INTENT"],
    },
    {
      type: "custom",
      name: "ea-signature-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "LIFE", "CALENDAR"],
        description: "signature reminder scheduling",
        includesAny: ["sign", "appointment", "clinic", "docs"],
      }),
    },
    {
      type: "custom",
      name: "ea-signature-device-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["desktop", "mobile"],
        description: "signature reminder landed on a user device",
      }),
    },
    judgeRubric({
      name: "ea-signature-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant detected the signature-before-appointment task and scheduled at least one device reminder tied to the appointment time. No silent pass.",
    }),
  ],
});
