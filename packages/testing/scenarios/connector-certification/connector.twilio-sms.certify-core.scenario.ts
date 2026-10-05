/** Scenario fixture for connector twilio sms certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.twilio-sms.certify-core",
  title: "Certify Twilio SMS send-after-approval",
  connector: "twilio-sms",
  axis: "core",
  description:
    "Connector certification for approval-gated Twilio SMS sends, delivery state, and retry-safe dispatch behavior.",
  turns: [
    {
      name: "twilio-sms-propose",
      text: "Create an SMS draft on channel sms to target +15555550101 with message 'Running 10 minutes late for lunch.' Keep confirmed false so it waits for approval, and do not place a voice call.",
      responseIncludesAny: ["sms", "twilio", "confirm", "draft"],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["sms", "confirm", "draft", "15555550101"],
    },
    {
      name: "twilio-sms-confirm",
      text: "Set channel sms and confirmed true, then send that SMS text to +15555550101 now. Do not place a voice call.",
      responseIncludesAny: ["sms", "sent", "twilio"],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["sms", "send", "twilio"],
    },
  ],
  finalChecks: [
    { type: "approvalRequestExists", expected: true },
    { type: "messageDelivered", channel: "sms", expected: true },
  ],
});
