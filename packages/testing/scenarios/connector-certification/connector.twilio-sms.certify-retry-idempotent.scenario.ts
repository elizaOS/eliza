/** Scenario fixture for connector twilio sms certify retry idempotent; runs through scenario-runner with deterministic services unless the scenario name marks an external-service gate. */
import { buildConnectorCertificationScenario } from "./_factory.ts";

export default buildConnectorCertificationScenario({
  lane: "live-only",
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
      // The prompt never names the seeded fault; the agent must discover the
      // transient first-attempt failure itself and report the safe retry.
      text: "Send an SMS to +15555550101 saying 'Running 10 minutes late for lunch.' Make sure exactly one copy reaches them, and report how the delivery actually went.",
      responseIncludesAny: [
        "retried",
        "second attempt",
        "transient",
        "delivered",
      ],
      expectedActions: ["MESSAGE"],
      actionPayloadIncludesAny: ["sms", "retry", "twilio", "15555550101"],
      responseJudge: {
        rubric:
          "The reply reports that the first Twilio attempt failed transiently and that a safe retry delivered exactly one SMS, with no duplicate sends.",
        minimumScore: 0.6,
      },
    },
  ],
  finalChecks: [
    { type: "connectorDispatchOccurred", channel: "sms" },
    { type: "messageDelivered", channel: "sms", expected: true },
  ],
});
