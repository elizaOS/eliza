/** Builds data-only provider canaries whose effects can only be proven by the external qualification protocol. */
import { scenario } from "@elizaos/scenario-runner/schema";
export type ProviderCanaryConfig = {
  lane: "live-only";
  executionProfile: "provider-qualified";
  evidenceScope: "provider-certification";
  isolation: "per-scenario";
  id: string;
  title: string;
  provider: string;
  operation: string;
  plugins: string[];
  effectLabel: string;
  targetLabel: string;
  payload: string;
};
export function buildProviderCanary(config: ProviderCanaryConfig) {
  const observerId = `${config.provider}-provider-observer`;
  const accountId = `operator-${config.provider}-canary-account`;
  return scenario({
    id: config.id,
    title: config.title,
    description: `Performs one harmless ${config.effectLabel} on an operator-owned ${config.targetLabel}. This definition cannot qualify itself: an external controller must bind the real account and independently prove the ${config.provider} effect.`,
    domain: "provider-canary",
    lane: config.lane,
    executionProfile: config.executionProfile,
    evidenceScope: config.evidenceScope,
    isolation: config.isolation,
    requires: { plugins: config.plugins },
    tags: ["provider-canary", config.provider, "external-observer"],
    turns: [
      {
        kind: "message",
        name: `perform operator-owned ${config.provider} canary`,
        text: `Perform exactly one ${config.effectLabel} on the operator-owned ${config.targetLabel} using this harmless payload: '${config.payload}'. This is the explicit confirmation to do it now.`,
        responseJudge: {
          minimumScore: 0.9,
          rubric: `The response must report one ${config.provider} ${config.effectLabel} attempt on the named canary target without claiming provider completion unless the provider actually accepted it.`,
        },
      },
    ],
    finalChecks: [
      {
        type: "providerEffectObserved",
        name: `${config.provider}-canary-${config.operation}`,
        observerId,
        provider: config.provider,
        accountId,
        operation: config.operation,
        minCount: 1,
      },
      {
        type: "judgeRubric",
        name: `${config.provider}-canary-semantic-result`,
        minimumScore: 0.9,
        rubric: `The agent must honor the exact one-effect scope and distinguish an attempted ${config.effectLabel} from provider-confirmed completion.`,
      },
    ],
  });
}
