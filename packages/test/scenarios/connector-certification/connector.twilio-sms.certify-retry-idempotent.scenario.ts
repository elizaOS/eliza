import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.twilio-sms.certify-retry-idempotent",
  title: "Certify Twilio SMS retry-safe idempotent send handling",
  connector: "twilio-sms",
  axis: "retry-idempotent",
  description:
    "Connector certification for Twilio SMS when the first delivery attempt fails transiently and the assistant must retry safely without duplicate sends.",
  seed: [
    {
      type: "transportFault",
      connector: "twilio-sms",
      provider: "Twilio",
      state: "retry-idempotent",
      limit: 1,
    },
  ],
  turns: [
    {
      name: "twilio-sms-retry-safe",
      text: "Send an SMS to +15555550101 saying 'Running 10 minutes late for lunch.' If Twilio fails once transiently, retry safely but do not deliver duplicates.",
      responseIncludesAny: ["sms", "retry", "twilio", "late"],
      acceptedActions: ["MESSAGE"],
      includesAny: ["sms", "retry", "twilio", "15555550101"],
    },
  ],
  finalChecks: [
    { type: "connectorDispatchOccurred", channel: "sms" },
    { type: "messageDelivered", channel: "sms", expected: true },
  ],
});
