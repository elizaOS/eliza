import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.meeting-reminder-T-1h",
  title: "Schedule a T-1h meeting reminder on desktop + mobile",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "reminder", "T-1h"],
  description:
    "User asks for a 1-hour-before reminder. Agent must schedule a DEVICE_INTENT for 1h pre-meeting on both desktop and mobile, and confirm the timing back.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "T-1h reminder",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "schedule-1h",
      room: "main",
      text: "Remind me 1 hour before my 3pm board call on desktop and phone.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "T-1h reminder schedule",
        includesAny: ["1 hour", "60", "hour", "board", "3pm"],
      }),
      responseIncludesAny: ["1 hour", "hour", "board", "3pm"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must commit to a 1-hour-before reminder on both desktop AND mobile for the 3pm board call. Vague 'I'll remind you' fails.",
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
      name: "push-T-1h-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "T-1h reminder",
      }),
    },
    {
      type: "custom",
      name: "push-T-1h-dispatch",
      predicate: expectConnectorDispatch({
        channel: ["desktop", "mobile"],
        description: "T-1h reminder dispatched to both surfaces",
      }),
    },
    judgeRubric({
      name: "push-T-1h-rubric",
      threshold: 0.7,
      description:
        "T-1h reminder scheduled on desktop + mobile with the correct meeting tied.",
    }),
  ],
});
