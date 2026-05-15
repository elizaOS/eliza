import { scenario } from "@elizaos/scenario-schema";
import {
  expectConnectorDispatch,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "twilio.call.outbound-with-confirmation",
  title: "Agent places outbound Twilio call after confirmation",
  domain: "gateway",
  tags: ["gateway", "twilio", "call", "confirms-destructive-edge"],
  description:
    "The assistant drafts a real third-party phone call behind approval, then places it only after the user confirms.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Twilio Call Outbound With Confirmation",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "propose-call",
      room: "main",
      text: "Call Downtown Dental at +15555550101 and reschedule my appointment to next Tuesday, but wait for my approval before dialing.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["VOICE_CALL"],
        description: "twilio outbound call draft",
        includesAny: ["call", "downtown", "dental", "confirm", "15555550101"],
      }),
      responseIncludesAny: ["confirm", "call", "Downtown Dental", "Tuesday"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 1 must hold the Twilio call behind explicit approval instead of pretending it already dialed.",
      },
    },
    {
      kind: "message",
      name: "confirm-call",
      room: "main",
      text: "Yes, place the call to +15555550101 now.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["VOICE_CALL"],
        description: "twilio outbound call confirmed",
        includesAny: ["call", "place", "dial", "15555550101"],
      }),
      responseIncludesAny: ["calling", "dialing", "placed", "call"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Turn 2 must make clear that the confirmed Twilio call is being placed now.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["VOICE_CALL"],
    },
    {
      type: "approvalRequestExists",
      expected: true,
    },
    {
      type: "pushSent",
      channel: "phone_call",
    },
    {
      type: "connectorDispatchOccurred",
      channel: "phone_call",
      actionName: ["VOICE_CALL"],
    },
    {
      type: "custom",
      name: "twilio-call-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["VOICE_CALL"],
        description: "twilio outbound call draft then send",
        includesAny: ["call", "confirm", "dial", "15555550101"],
        minCount: 2,
      }),
    },
    {
      type: "custom",
      name: "twilio-call-dispatch",
      predicate: expectConnectorDispatch({
        channel: "phone_call",
        actionName: ["VOICE_CALL"],
        description:
          "the confirmed Twilio call goes through the voice dispatcher",
      }),
    },
    judgeRubric({
      name: "twilio-call-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant held the third-party call for approval and only dialed after explicit confirmation.",
    }),
  ],
});
