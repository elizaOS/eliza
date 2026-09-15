/**
 * Defines the Gmail canary whose publication requires an operator manifest,
 * signed provider observation, and independent semantic judgment.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "provider.gmail.confirmed-send",
  title: "Provider-qualified Gmail confirmed-send canary",
  description:
    "Sends one harmless message between operator-owned Gmail canary accounts. This definition is not runnable certification by itself: an external controller must bind the accounts and prove the provider effect.",
  domain: "provider-canary",
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  requires: {
    plugins: [
      "@elizaos/plugin-personal-assistant",
      "@elizaos/plugin-google-workspace",
    ],
  },
  tags: ["provider-canary", "gmail", "external-observer"],
  turns: [
    {
      kind: "message",
      name: "send operator-owned gmail canary",
      text: "Send exactly one email to the operator-owned Gmail canary recipient with subject 'elizaOS provider canary' and body 'Gmail provider canary delivery'. This is the explicit confirmation to send it now.",
      responseJudge: {
        minimumScore: 0.9,
        rubric:
          "The response must report a single Gmail send attempt to the named canary target without claiming provider delivery unless the provider actually accepted it.",
      },
    },
  ],
  finalChecks: [
    {
      type: "providerEffectObserved",
      name: "gmail-canary-email-send",
      observerId: "gmail-provider-observer",
      provider: "gmail",
      connectorProvider: "google",
      accountId: "operator-gmail-canary-account",
      operation: "email-send",
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "gmail-canary-semantic-result",
      minimumScore: 0.9,
      rubric:
        "The agent must honor the exact one-message scope and distinguish an attempted send from provider-confirmed delivery.",
    },
  ],
});
