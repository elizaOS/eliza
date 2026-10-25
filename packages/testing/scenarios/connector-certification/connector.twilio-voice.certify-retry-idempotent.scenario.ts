/** Scenario fixture for connector twilio voice certify retry idempotent; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
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
      // Held-draft tokens the prompt never uses; parroting "keep confirmed
      // false" cannot satisfy any of them.
      responseIncludesAny: ["queued", "pending", "awaiting", "ready for your"],
      expectedActions: ["VOICE_CALL"],
      actionPayloadIncludesAny: ["call", "twilio", "confirm", "dental"],
    },
    {
      name: "twilio-voice-confirm-retry-safe",
      // The prompt never names the seeded fault; the agent must discover the
      // first-attempt timeout itself and report the safe single retry.
      text: "Now place that Twilio voice call and tell me how the attempt actually went.",
      responseIncludesAny: ["retried", "second attempt", "timed out", "placed"],
      expectedActions: ["VOICE_CALL"],
      actionPayloadIncludesAny: ["call", "retry", "twilio", "dental"],
      responseJudge: {
        rubric:
          "The reply reports that the first call attempt timed out and that a safe retry placed exactly one call, with no double-dial of the dental office.",
        minimumScore: 0.6,
      },
    },
  ],
  finalChecks: [
    { type: "approvalRequestExists", expected: true },
    { type: "connectorDispatchOccurred", channel: "voice" },
  ],
});
