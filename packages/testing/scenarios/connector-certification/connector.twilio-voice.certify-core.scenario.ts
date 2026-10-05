/** Scenario fixture for connector twilio voice certify core; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
  id: "connector.twilio-voice.certify-core",
  title: "Certify Twilio voice approval and outcome tracking",
  connector: "twilio-voice",
  axis: "core",
  description:
    "Connector certification for approval-gated Twilio voice calls, outcome state, and escalation-ladder integration.",
  turns: [
    {
      name: "twilio-voice-propose",
      text: "Create a Twilio voice call draft with CALL_EXTERNAL to Downtown Dental using the spoken message 'This is a connector certification call.' Keep confirmed false so it waits for approval.",
      // Held-draft tokens the prompt never uses; parroting "keep confirmed
      // false" cannot satisfy any of them.
      responseIncludesAny: ["queued", "pending", "awaiting", "ready for your"],
      expectedActions: ["VOICE_CALL"],
      actionPayloadIncludesAny: ["call", "twilio", "confirm", "downtown"],
    },
    {
      name: "twilio-voice-confirm",
      text: "Set confirmed true and place that CALL_EXTERNAL Twilio voice call to Downtown Dental now.",
      // Call-outcome tokens: a real confirm reports the placed/dialing call.
      responseIncludesAny: ["placed", "dialing", "ringing", "underway"],
      expectedActions: ["VOICE_CALL"],
      actionPayloadIncludesAny: ["call", "place", "dial", "downtown"],
    },
  ],
  finalChecks: [
    { type: "approvalRequestExists", expected: true },
    { type: "pushSent", channel: "phone_call" },
  ],
});
