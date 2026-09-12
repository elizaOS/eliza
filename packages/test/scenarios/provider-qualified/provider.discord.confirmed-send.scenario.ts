/**
 * Defines the Discord canary whose publication requires an operator manifest,
 * signed provider observation, and independent semantic judgment.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "provider.discord.confirmed-send",
  title: "Provider-qualified Discord confirmed-send canary",
  description:
    "Posts one harmless message to an operator-owned private Discord canary channel. This definition cannot qualify itself; an external controller must bind the channel and prove the Discord effect.",
  domain: "provider-canary",
  lane: "live-only",
  executionProfile: "provider-qualified",
  evidenceScope: "provider-certification",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-personal-assistant", "@elizaos/plugin-discord"],
  },
  tags: ["provider-canary", "discord", "external-observer"],
  turns: [
    {
      kind: "message",
      name: "send operator-owned discord canary",
      text: "Post exactly one message in the operator-owned private Discord canary channel: 'Discord provider canary delivery'. This is the explicit confirmation to send it now.",
      responseJudge: {
        minimumScore: 0.9,
        rubric:
          "The response must report a single Discord post attempt to the named private canary channel without claiming delivery unless Discord actually accepted it.",
      },
    },
  ],
  finalChecks: [
    {
      type: "providerEffectObserved",
      name: "discord-canary-message-send",
      observerId: "discord-provider-observer",
      provider: "discord",
      connectorProvider: "discord",
      accountId: "operator-discord-canary-account",
      operation: "message-send",
      minCount: 1,
    },
    {
      type: "judgeRubric",
      name: "discord-canary-semantic-result",
      minimumScore: 0.9,
      rubric:
        "The agent must honor the exact one-message scope and distinguish an attempted post from provider-confirmed delivery.",
    },
  ],
});
