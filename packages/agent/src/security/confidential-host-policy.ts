/**
 * Verifies the expiring processor policy required by the measured confidential
 * host. Measured configuration pins the signing authority and cryptographic
 * verifier; signed approvals identify processors without treating a URL or
 * attestation as proof of contractual eligibility or geographic location.
 */
import {
  createHash,
  createPublicKey,
  type KeyObject,
  verify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type ConfidentialInferenceProfile, ElizaError } from "@elizaos/core";
import { z } from "zod";
import { dstackVerifierConfiguration } from "../services/tee-dstack-evidence.ts";

export const CONFIDENTIAL_PROCESSOR_SIGNATURE_DOMAIN =
  "eliza-confidential-processors-v1\0";
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const httpsEndpoint = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.href === value
    );
  } catch {
    // error-policy:J3 A malformed endpoint cannot become an approved route.
    return false;
  }
});
const transportIdentity = dstackVerifierConfiguration
  .pick({
    appId: true,
    composeHash: true,
    osImageHash: true,
    variant: true,
  })
  .strict();

export const confidentialHostConfiguration = z
  .object({
    schema: z.literal("eliza-confidential-host-v1"),
    agentId: z.uuid(),
    deploymentId: identifier,
    stateDirectory: z.string().refine(isAbsolute),
    processorPolicyPath: z.string().refine(isAbsolute),
    processorPolicyPublicKey: z
      .string()
      .startsWith("-----BEGIN PUBLIC KEY-----"),
    allowedRegions: z.array(identifier).min(1),
    verifier: dstackVerifierConfiguration.strict(),
    inferenceTransport: z
      .object({
        unixSocketPath: z.string().refine(isAbsolute).optional(),
        caPem: z.string().startsWith("-----BEGIN CERTIFICATE-----").optional(),
      })
      .strict()
      .optional(),
    listen: z
      .object({
        host: z.enum(["127.0.0.1", "::1"]),
        port: z.number().int().min(0).max(65535),
      })
      .strict(),
    character: z
      .object({
        name: z.string().min(1),
        bio: z.array(z.string()),
        system: z.string(),
      })
      .strict(),
  })
  .strict();
export type ConfidentialHostConfiguration = z.input<
  typeof confidentialHostConfiguration
>;

const processorPolicy = z
  .object({
    schema: z.literal("eliza-confidential-processors-v1"),
    agentId: z.uuid(),
    deploymentId: identifier,
    revision: identifier,
    notBefore: z.number().int().nonnegative(),
    expiresAt: z.number().int().positive(),
    routes: z
      .array(
        z
          .object({
            id: identifier,
            endpoint: httpsEndpoint,
            model: z.string().min(1),
            modelTypes: z.array(identifier).min(1),
            adapter: z.literal("openai-compatible"),
            transportIdentity,
            processorApproval: z
              .object({
                provider: identifier,
                service: identifier,
                region: identifier,
                contractRef: identifier,
                approvalRef: identifier,
                expiresAt: z.number().int().positive(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
const signedEnvelope = z
  .object({
    payload: z.string(),
    signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
  })
  .strict();
export type ApprovedProcessorPolicy = z.output<typeof processorPolicy>;

function rejected(): ElizaError {
  return new ElizaError(
    "Confidential host requires a current signed processor policy for its measured deployment",
    {
      code: "CONFIDENTIAL_HOST_POLICY_REJECTED",
    },
  );
}

/** Schema parsing has already produced an acyclic, JSON-shaped configuration. */
function freezeConfiguration(value: object): void {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") freezeConfiguration(child);
  }
  Object.freeze(value);
}

/** The entry supplies measured configuration; application settings never call this. */
export function createConfidentialHostPolicy(
  input: ConfidentialHostConfiguration,
) {
  const parsed = confidentialHostConfiguration.safeParse(input);
  if (!parsed.success) throw rejected();
  const config = parsed.data;
  freezeConfiguration(config);
  let publicKey: KeyObject;
  try {
    publicKey = createPublicKey(config.processorPolicyPublicKey);
  } catch {
    // error-policy:J1 Invalid measured signing keys fail without exposing configuration.
    throw rejected();
  }
  if (publicKey.asymmetricKeyType !== "ed25519") throw rejected();
  const { appId, composeHash, osImageHash, variant } = config.verifier;
  const expectedIdentity = { appId, composeHash, osImageHash, variant };

  function read(): { policy: ApprovedProcessorPolicy; digest: string } {
    try {
      const envelope = signedEnvelope.parse(
        JSON.parse(readFileSync(config.processorPolicyPath, "utf8")),
      );
      const valid = verify(
        null,
        Buffer.from(CONFIDENTIAL_PROCESSOR_SIGNATURE_DOMAIN + envelope.payload),
        publicKey,
        Buffer.from(envelope.signature, "base64"),
      );
      if (!valid) throw rejected();
      const policy = processorPolicy.parse(JSON.parse(envelope.payload));
      const now = Date.now();
      if (
        policy.agentId !== config.agentId ||
        policy.deploymentId !== config.deploymentId ||
        policy.notBefore > now ||
        policy.expiresAt <= now ||
        policy.notBefore >= policy.expiresAt ||
        new Set(policy.routes.map((route) => route.id)).size !==
          policy.routes.length
      )
        throw rejected();
      for (const route of policy.routes) {
        if (
          route.processorApproval.expiresAt <= now ||
          !config.allowedRegions.includes(route.processorApproval.region) ||
          JSON.stringify(route.transportIdentity) !==
            JSON.stringify(expectedIdentity)
        )
          throw rejected();
      }
      return {
        policy,
        digest: createHash("sha256").update(envelope.payload).digest("hex"),
      };
    } catch {
      // error-policy:J1 Policy parsing/signature failures expose no control-file contents.
      throw rejected();
    }
  }

  function currentProfile(): ConfidentialInferenceProfile {
    const { policy, digest } = read();
    return {
      // Bind the complete signed approval, not just a publisher-chosen revision.
      revision: `${policy.revision}:${digest}`,
      expiresAt: Math.min(
        policy.expiresAt,
        ...policy.routes.map((route) => route.processorApproval.expiresAt),
      ),
      routes: policy.routes.map(({ id, endpoint, model, modelTypes }) => ({
        id,
        endpoint,
        model,
        modelTypes,
      })),
    };
  }

  // Missing or invalid policy prevents host construction, not only first inference.
  currentProfile();
  return { config, read, currentProfile };
}
