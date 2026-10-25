/**
 * Authenticated, challenge-bound dstack attestation for remote operators. The
 * route returns only raw guest-v1 evidence for an operator nonce; it never
 * reports its own verdict. Operators appraise the evidence off-box with their
 * own pinned dstack-verifier and expected release identity
 * (packages/app/scripts/alpha-dstack.ts verify-attestation).
 */
import { createHash } from "node:crypto";
import { logger } from "@elizaos/core";
import type { Route } from "@elizaos/host/protocol";
import { collectDstackAttestation } from "../services/tee-dstack-evidence.ts";
import { resolveDstackEvidenceConfiguration } from "../services/tee-dstack-release.ts";

export const DSTACK_OPERATOR_ATTESTATION_PATH = "/api/tee/dstack/attestation";
const OPERATOR_ATTESTATION_DOMAIN = "eliza-dstack-operator-attestation-v1\0";
const NONCE = /^[0-9a-f]{64}$/;

/** Domain-separates operator challenges from every other report-data use. */
export function dstackOperatorReportData(nonceHex: string): string {
  if (!NONCE.test(nonceHex)) {
    throw new TypeError("Operator nonce must be 32 bytes of lowercase hex");
  }
  return createHash("sha256")
    .update(OPERATOR_ATTESTATION_DOMAIN)
    .update(Buffer.from(nonceHex, "hex"))
    .digest("hex");
}

function failure(status: number, error: string) {
  return { status, body: { error } };
}

export const dstackOperatorAttestationRoute: Route = {
  type: "POST",
  path: DSTACK_OPERATOR_ATTESTATION_PATH,
  rawPath: true,
  name: "tee-dstack-operator-attestation",
  routeHandler: async (ctx) => {
    const body = ctx.body as { nonce?: unknown } | null | undefined;
    const nonce = typeof body?.nonce === "string" ? body.nonce : "";
    if (!NONCE.test(nonce)) {
      return failure(400, "TEE_ATTESTATION_NONCE_INVALID");
    }
    if (process.env.ELIZA_DSTACK_EVIDENCE_CONFIG_JSON === undefined) {
      return failure(404, "TEE_DSTACK_NOT_CONFIGURED");
    }
    let socketPath: string;
    let timeoutMs: number;
    try {
      ({ socketPath, timeoutMs } = resolveDstackEvidenceConfiguration(
        process.env,
      ));
    } catch (error) {
      // error-policy:J1 Configuration diagnostics stay in the structured log.
      logger.error(
        { error },
        "[TeeAttestation] dstack evidence configuration is invalid",
      );
      return failure(503, "TEE_DSTACK_CONFIGURATION_INVALID");
    }
    const reportData = dstackOperatorReportData(nonce);
    try {
      const attestation = await collectDstackAttestation(
        socketPath,
        reportData,
        AbortSignal.timeout(timeoutMs),
      );
      return { status: 200, body: { nonce, reportData, attestation } };
    } catch (error) {
      // error-policy:J1 Guest-socket failures never become fabricated evidence.
      logger.error(
        { error },
        "[TeeAttestation] dstack guest attestation failed",
      );
      return failure(502, "TEE_DSTACK_ATTESTATION_UNAVAILABLE");
    }
  },
};
