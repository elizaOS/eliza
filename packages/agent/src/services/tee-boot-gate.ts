/**
 * Boot-time TEE trust gate for @elizaos/agent: evaluates attestation trust once
 * at startup and reports whether high-value secret, model-key-release, signing,
 * and remote-plugin-sync capabilities may be enabled. Fail-closed by contract —
 * a required-but-untrusted (or provider-less) decision disables secrets while
 * still allowing a degraded, secret-less boot. See the TeeBootGate type below
 * for the decision fields and the fail-closed invariant it carries.
 */
import { logger } from "@elizaos/core";
import type { TeeEvidenceProvider } from "./tee-evidence.ts";
import {
  evaluateTeeEvidencePolicy,
  type TeeEvidencePolicy,
  type TeeEvidencePolicyDecision,
} from "./tee-policy.ts";
import {
  mergeTeeProductionProfile,
  type TeeProductionProfileOptions,
} from "./tee-production-profile.ts";
import {
  type ResolveTeeRuntimePolicyOptions,
  resolveTeeRuntimePolicy,
} from "./tee-runtime-config.ts";

/**
 * Boot-time TEE gate (plan §4.1). Consumes the resolved runtime policy, applies
 * the production profile when configured, collects evidence via the provider,
 * and evaluates trust ONCE at startup. The result tells the boot path which
 * high-value capabilities may be enabled.
 *
 * Fail-closed contract: when the policy requires TEE and the decision is not
 * trusted, NONE of model-key release, signing, agent-session secrets, or remote
 * plugin sync may be enabled. The agent may still boot in a degraded,
 * secret-less mode, but it must surface the failed decision via the structured
 * logger ([TeeBootGate]) and never silently proceed with secrets.
 */
export type TeeBootGate = {
  /** Resolved + production-merged policy actually evaluated (undefined ⇒ TEE not configured). */
  policy: TeeEvidencePolicy | undefined;
  /** True when no TEE policy is configured at all (local-only, no gating). */
  teeConfigured: boolean;
  /** True when the configured policy demands trusted evidence. */
  required: boolean;
  /** True when the production profile was merged in. */
  productionProfile: boolean;
  /** The single boot-time trust decision, when a policy was evaluated. */
  decision?: TeeEvidencePolicyDecision;
  /** Whether high-value secret/key/signing/sync capabilities may be enabled. */
  secretsEnabled: boolean;
};

export type EvaluateTeeBootGateOptions = {
  env?: Record<string, string | undefined>;
  evidenceProvider?: TeeEvidenceProvider;
  resolveOptions?: ResolveTeeRuntimePolicyOptions;
  profileOptions?: TeeProductionProfileOptions;
  nowMs?: number;
};

export async function evaluateTeeBootGate(
  options: EvaluateTeeBootGateOptions = {},
): Promise<TeeBootGate> {
  const env = options.env ?? process.env;
  const resolved = await resolveTeeRuntimePolicy({
    env,
    ...(options.nowMs === undefined ? {} : { nowMs: options.nowMs }),
    ...(options.resolveOptions ?? {}),
  });
  const useProductionProfile = env.ELIZA_TEE_PRODUCTION_PROFILE === "true";

  if (resolved === undefined && !useProductionProfile) {
    return {
      policy: undefined,
      teeConfigured: false,
      required: false,
      productionProfile: false,
      secretsEnabled: true,
    };
  }

  const policy = useProductionProfile
    ? mergeTeeProductionProfile(resolved, options.profileOptions ?? {})
    : resolved;
  const required = policy?.required === true;

  if (!required) {
    return {
      policy,
      teeConfigured: policy !== undefined,
      required: false,
      productionProfile: useProductionProfile,
      secretsEnabled: true,
    };
  }

  if (!options.evidenceProvider) {
    logger.error(
      "[TeeBootGate] ELIZA_TEE_REQUIRED is set but no evidence provider is configured; refusing to enable secrets.",
    );
    return {
      policy,
      teeConfigured: true,
      required: true,
      productionProfile: useProductionProfile,
      secretsEnabled: false,
    };
  }

  const evidence = await options.evidenceProvider.collectEvidence();
  const decision = evaluateTeeEvidencePolicy(evidence, policy);
  if (!decision.trusted) {
    logger.error(
      { reason: decision.reason, detail: decision.detail },
      "[TeeBootGate] TEE evidence is not trusted; secrets, model-key release, signing, and remote plugin sync are disabled.",
    );
    return {
      policy,
      teeConfigured: true,
      required: true,
      productionProfile: useProductionProfile,
      decision,
      secretsEnabled: false,
    };
  }

  logger.info(
    {
      reason: decision.reason,
      productionProfile: useProductionProfile,
    },
    "[TeeBootGate] TEE evidence trusted; high-value capabilities enabled.",
  );
  return {
    policy,
    teeConfigured: true,
    required: true,
    productionProfile: useProductionProfile,
    decision,
    secretsEnabled: true,
  };
}

/**
 * Guard a high-value capability behind the boot gate. Throws fail-closed when
 * secrets are disabled, so a caller cannot accidentally release a key/secret or
 * sync plugins after a failed attestation.
 */
export function assertTeeBootGateAllowsSecrets(
  gate: TeeBootGate,
  capability: string,
): void {
  if (!gate.secretsEnabled) {
    throw new Error(
      `[TeeBootGate] ${capability} blocked: TEE evidence is not trusted (${
        gate.decision?.detail ?? gate.decision?.reason ?? "no evidence provider"
      }).`,
    );
  }
}
