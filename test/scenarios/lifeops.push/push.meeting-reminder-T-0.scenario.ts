import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.meeting-reminder-T-0",
  title: "Fire a start-time meeting reminder with the join link",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "reminder", "T-0"],
  description:
    "User wants a reminder right at meeting start with the join link inline. Agent must schedule via DEVICE_INTENT for T=0 and embed the link in the payload.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "T-0 reminder with link",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "calendar-event",
        title: "Eng standup",
        startAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        joinLink: "https://meet.example.com/eng-standup",
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "schedule-T-0",
      room: "main",
      text: "Ping me right when eng standup starts with the join link.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "T-0 reminder with join link",
        includesAny: ["start", "join", "link", "standup"],
      }),
      responseIncludesAny: ["start", "join", "link", "standup"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must commit to a T=0 reminder and include the join link. Sending without the link, or before/after start, both fail.",
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
      name: "push-T-0-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "T-0 reminder + join link",
      }),
    },
    {
      type: "custom",
      name: "push-T-0-dispatch-with-link",
      predicate: expectConnectorDispatch({
        channel: ["desktop", "mobile"],
        description: "T-0 reminder dispatched with join link in payload",
        payloadIncludesAny: ["meet.example.com", "join", "link"],
      }),
    },
    judgeRubric({
      name: "push-T-0-rubric",
      threshold: 0.7,
      description:
        "T-0 reminder fires with the join link visible.",
    }),
  ],
});
