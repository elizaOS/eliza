import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
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
      responseIncludesAny: ["call", "twilio", "confirm"],
      acceptedActions: ["VOICE_CALL"],
      includesAny: ["call", "twilio", "confirm", "downtown"],
    },
    {
      name: "twilio-voice-confirm",
      text: "Set confirmed true and place that CALL_EXTERNAL Twilio voice call to Downtown Dental now.",
      responseIncludesAny: ["call", "placed", "dialing"],
      acceptedActions: ["VOICE_CALL"],
      includesAny: ["call", "place", "dial", "downtown"],
    },
  ],
  finalChecks: [
    { type: "approvalRequestExists", expected: true },
    { type: "pushSent", channel: "phone_call" },
  ],
});
