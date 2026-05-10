import { scenario } from "@elizaos/scenario-schema";
import { expectTurnToCallAction } from "../_helpers/action-assertions.ts";

export default scenario({
  id: "twilio.sms.receive-route-to-agent",
  title: "Incoming Twilio SMS routes to the user's agent",
  domain: "gateway",
  tags: ["gateway", "twilio", "sms", "smoke"],
  description:
    "Inbound Twilio SMS is routed to the active user agent and produces a real reply path. Signed webhook coverage and dedupe remain covered by the webhook integration tests.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "twilio",
      channelType: "DM",
      title: "Twilio SMS Receive",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "inbound-sms",
      room: "main",
      text: 'Please route this incoming Twilio text to the right agent and reply naturally. Exact SMS: "I am running 20 minutes late, the freeway is backed up, I will update you when I am parked, and please start the meeting without me if I am not there by 9:15."',
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["REPLY", "MESSAGE", "MESSAGE"],
        description: "twilio sms route-to-agent",
        includesAny: ["got", "received", "text", "SMS"],
      }),
      responseIncludesAny: ["got", "received", "text", "SMS"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["REPLY", "MESSAGE", "MESSAGE"],
    },
    {
      type: "custom",
      name: "twilio-sms-route-produces-action-and-reply",
      predicate: async (ctx) => {
        const reply = String(ctx.turns?.[0]?.responseText ?? "").trim();
        if (!reply) {
          return "expected a non-empty Twilio SMS reply";
        }
        if ((ctx.turns?.[0]?.actionsCalled.length ?? 0) === 0) {
          return "expected the inbound Twilio SMS to call at least one action";
        }
      },
    },
  ],
});
