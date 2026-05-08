import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "twilio.call.receive",
  title: "Inbound Twilio voice transcript routes to the agent",
  domain: "gateway",
  tags: ["gateway", "twilio", "call", "smoke"],
  description:
    "Once an inbound Twilio voice call has been transcribed into the user's Twilio room, the agent should treat it like real inbound message context and respond through a normal action path.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "twilio",
      channelType: "DM",
      title: "Twilio Call Receive",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "inbound-call",
      room: "main",
      text: "[call transcript] Hi agent, this is a voice call coming in from my phone.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["REPLY", "MESSAGE", "MESSAGE"],
        description: "twilio voice transcript route-to-agent",
        includesAny: ["call", "voice", "received", "hello"],
      }),
      responseIncludesAny: ["call", "voice", "received", "hello"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["REPLY", "MESSAGE", "MESSAGE"],
    },
    {
      type: "custom",
      name: "twilio-call-receive-produces-grounded-response",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["REPLY", "MESSAGE", "MESSAGE"],
        description: "twilio voice transcript route-to-agent",
        includesAny: ["call", "voice", "received", "hello"],
      }),
    },
    {
      type: "custom",
      name: "twilio-call-receive-response-is-nonempty",
      predicate: async (ctx) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").trim();
        if (!reply) {
          return "expected a non-empty Twilio voice transcript response";
        }
        if ((ctx.turns?.[0]?.actionsCalled.length ?? 0) === 0) {
          return "expected the inbound Twilio voice transcript to invoke at least one action";
        }
        return undefined;
      },
    },
  ],
});
