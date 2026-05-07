import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  id: "connector.twilio-voice.certify-retry-idempotent",
  title: "Certify Twilio voice retry-safe idempotent call handling",
  connector: "twilio-voice",
  axis: "retry-idempotent",
  description:
    "Connector certification for Twilio voice when the first call attempt times out and the assistant must retry safely without double-dialing.",
  seed: [
    {
      type: "transportFault",
      connector: "twilio-voice",
      provider: "Twilio",
      state: "retry-idempotent",
      limit: 1,
    },
  ],
  turns: [
    {
      name: "twilio-voice-retry-safe",
      text: "Create a Twilio voice call draft with CALL_EXTERNAL to Downtown Dental using the spoken message 'Running 10 minutes late for the appointment.' Keep confirmed false so it waits for approval.",
      responseIncludesAny: ["call", "twilio", "confirm", "dental"],
      acceptedActions: ["VOICE_CALL"],
      includesAny: ["call", "twilio", "confirm", "dental"],
    },
    {
      name: "twilio-voice-confirm-retry-safe",
      text: "Now place that Twilio voice call. If Twilio times out once, retry safely without double-dialing Downtown Dental.",
      responseIncludesAny: ["call", "retry", "twilio", "dental"],
      acceptedActions: ["VOICE_CALL"],
      includesAny: ["call", "retry", "twilio", "dental"],
    },
  ],
  finalChecks: [
    { type: "approvalRequestExists", expected: true },
    { type: "connectorDispatchOccurred", channel: "voice" },
  ],
});
