/**
 * Defines the Twilio SMS canary whose publication requires an operator
 * manifest, signed provider observation, and independent semantic judgment.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "provider.twilio-sms.confirmed-send",
  title: "Provider-qualified Twilio SMS confirmed-send canary",
  description:
    "Sends one harmless SMS between operator-owned Twilio canary numbers. This definition cannot qualify itself; an external controller must bind the numbers and prove the Twilio effect.",
  domain: "provider-canary",
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-personal-assistant", "@elizaos/plugin-phone"],
  },
  tags: ["provider-canary", "twilio", "sms", "external-observer"],
  turns: [
    {
      kind: "message",
      name: "send operator-owned twilio sms canary",
      text: "Send exactly one SMS to the operator-owned Twilio canary number: 'Twilio SMS provider canary delivery'. This is the explicit confirmation to send it now.",
      responseJudge: {
        minimumScore: 0.9,
        rubric:
          "The response must report a single Twilio SMS attempt to the named canary number without claiming delivery unless Twilio actually accepted it.",
      },
    },
  ],
  finalChecks: [
    {
      type: "providerEffectObserved",
      name: "twilio-canary-sms-send",
      observerId: "twilio-provider-observer",
      provider: "twilio",
      accountId: "operator-twilio-canary-account",
      operation: "sms-send",
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "twilio-canary-semantic-result",
      minimumScore: 0.9,
      rubric:
        "The agent must honor the exact one-SMS scope and distinguish an attempted send from provider-confirmed delivery.",
    },
  ],
});
