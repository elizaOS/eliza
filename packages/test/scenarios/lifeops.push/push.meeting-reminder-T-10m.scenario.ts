import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.meeting-reminder-T-10m",
  title: "Schedule a T-10m meeting reminder on desktop + mobile",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "reminder", "T-10m"],
  description:
    "User asks for a 10-minute-before reminder for a specific meeting. Agent must schedule via DEVICE_INTENT and confirm the timing.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "T-10m reminder",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "schedule-10m",
      room: "main",
      text: "Ten-minute heads up before the 4pm investor sync on phone and desktop.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "T-10m reminder schedule",
        includesAny: ["10 minutes", "10m", "investor", "4pm"],
      }),
      responseIncludesAny: ["10 min", "ten min", "investor", "4pm"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must commit to a 10-minute-before reminder on both surfaces. Generic 'I'll remind you' fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT", "CALENDAR"],
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
      name: "push-T-10m-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "T-10m reminder",
      }),
    },
    {
      type: "custom",
      name: "push-T-10m-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["desktop", "mobile"],
        description: "T-10m reminder dispatched",
      }),
    },
    judgeRubric({
      name: "push-T-10m-rubric",
      threshold: 0.7,
      description:
        "T-10m reminder scheduled on desktop + mobile tied to the 4pm investor sync.",
    }),
  ],
});
