/**
 * Off-box appraisal of the Alpha agent's dstack evidence. The expected
 * identity comes only from the operator's signed release, the pinned verifier
 * digests from the image record, and processor approval from the signed
 * processor policy (confidential-host-policy). The agent supplies raw evidence
 * for a fresh operator nonce and never its own verdict.
 */
import { randomBytes, sign } from "node:crypto";
import { dstackOperatorReportData } from "@elizaos/agent/api/tee-attestation-routes";
import {
  CONFIDENTIAL_PROCESSOR_SIGNATURE_DOMAIN,
  type ConfidentialHostConfiguration,
  createConfidentialHostPolicy,
} from "@elizaos/agent/security/confidential-host-policy";
import { verifyDstackAttestation } from "@elizaos/agent/services/tee-dstack-evidence";
import { ElizaError } from "@elizaos/core";
import { z } from "zod";
import {
  ALPHA_AGENT_PORT,
  ALPHA_STATE_DIR,
  alphaDeploymentSchema,
  alphaImageRecordSchema,
} from "./alpha-dstack-deployment.ts";
import { verifyConfidentialRelease } from "./confidential-release.ts";

/** Signs a processor policy in the envelope createConfidentialHostPolicy reads. */
export function signAlphaProcessorPolicy(
  policy: unknown,
  authorityPrivateKeyPem: string,
): { payload: string; signature: string } {
  const payload = JSON.stringify(policy);
  const signature = sign(
    null,
    Buffer.from(CONFIDENTIAL_PROCESSOR_SIGNATURE_DOMAIN + payload),
    authorityPrivateKeyPem,
  ).toString("base64");
  return { payload, signature };
}

export interface AlphaAttestationInputs {
  deployment: unknown;
  image: unknown;
  /** Release input (from `render`) and its signed envelope. */
  release: unknown;
  releaseEnvelope: { payload: string; signature: string };
  authorityPublicKeyPem: string;
  processorPolicyPath: string;
  verifierPath: string;
  verifierConfigPath: string;
}

/** Builds the eliza-confidential-host-v1 document this deployment must satisfy. */
export function alphaHostConfiguration(
  inputs: AlphaAttestationInputs,
): ConfidentialHostConfiguration {
  const deployment = alphaDeploymentSchema.parse(inputs.deployment);
  const image = alphaImageRecordSchema.parse(inputs.image);
  const identity = verifyConfidentialRelease(
    inputs.release,
    inputs.releaseEnvelope,
    inputs.authorityPublicKeyPem,
  );
  return {
    schema: "eliza-confidential-host-v1",
    agentId: deployment.agentId,
    deploymentId: deployment.deploymentId,
    stateDirectory: ALPHA_STATE_DIR,
    processorPolicyPath: inputs.processorPolicyPath,
    processorPolicyPublicKey: inputs.authorityPublicKeyPem.trim(),
    allowedRegions: deployment.processors.allowedRegions,
    verifier: {
      verifierPath: inputs.verifierPath,
      verifierSha256: image.verifier.sha256,
      verifierConfigPath: inputs.verifierConfigPath,
      verifierConfigSha256: image.verifier.configSha256,
      appId: identity.appId,
      composeHash: identity.composeHash,
      osImageHash: identity.osImageHash,
      variant: identity.variant,
      releaseValidity: {
        notBefore: identity.notBefore,
        expiresAt: identity.expiresAt,
      },
    },
    listen: { host: "127.0.0.1", port: ALPHA_AGENT_PORT },
    character: {
      name: `alpha-${deployment.deploymentId}`,
      bio: [],
      system: "",
    },
  };
}

const attestationResponse = z
  .object({
    nonce: z.string(),
    reportData: z.string(),
    attestation: z.string().regex(/^(?:[0-9a-f]{2})+$/i),
  })
  .strict();

/**
 * Requests fresh evidence and appraises it. Rejects on an unsigned or expired
 * release/processor policy, a verifier digest mismatch, a replayed or foreign
 * challenge, a debug or out-of-date platform, or any identity difference.
 */
export async function verifyAlphaAttestation(
  inputs: AlphaAttestationInputs,
  requestEvidence: (nonce: string) => Promise<unknown>,
  signal?: AbortSignal,
) {
  const policy = createConfidentialHostPolicy(alphaHostConfiguration(inputs));
  const profile = policy.currentProfile();
  const nonce = randomBytes(32).toString("hex");
  const reportDataHex = dstackOperatorReportData(nonce);
  const response = attestationResponse.parse(await requestEvidence(nonce));
  if (response.nonce !== nonce || response.reportData !== reportDataHex) {
    throw new ElizaError("Agent answered a different attestation challenge", {
      code: "ALPHA_ATTESTATION_CHALLENGE_MISMATCH",
    });
  }
  const evidence = await verifyDstackAttestation(
    policy.config.verifier,
    response.attestation,
    { nonce, reportDataHex },
    signal,
  );
  return {
    appId: policy.config.verifier.appId,
    measurements: evidence.measurements,
    claims: evidence.claims,
    freshness: evidence.freshness,
    processorPolicy: profile.revision,
    approvedRoutes: profile.routes.map((route) => route.endpoint),
  };
}
