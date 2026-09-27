/**
 * Selects the protected host profile from the process environment captured at
 * entry. Once selected, local dstack admission must succeed before secrets,
 * listeners or plugins load, and dev/test trust substitutes are refused.
 * Config files and API writes cannot select, clear or relax the profile.
 */
import { ElizaError } from "@elizaos/core";
import { isDstackEvidenceProvider } from "../services/tee-dstack-evidence.ts";
import { resolveDstackEvidenceConfiguration } from "../services/tee-dstack-release.ts";
import {
  HttpTeeKeyReleaseClient,
  type TeeKeyReleaseClient,
  type TeeKeyReleaseResult,
} from "../services/tee-key-release.ts";
import {
  captureProtectedProfile,
  isProtectedProfileSelected,
} from "./protected-profile-state.ts";

export {
  captureProtectedProfile,
  getProtectedProfile,
  isProtectedProfileSelected,
  PROTECTED_PROFILE_ENV,
  PROTECTED_PROFILES,
  type ProtectedProfile,
  protectedTeeEnvironment,
} from "./protected-profile-state.ts";

let admission: Promise<void> | undefined;

function admissionRejected(cause?: unknown): ElizaError {
  return new ElizaError("Protected profile requires local TEE admission", {
    code: "PROTECTED_PROFILE_ADMISSION_REJECTED",
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Single-flight admission for the protected profile. Inert for ordinary hosts.
 * A rejection is retained: a failed admission cannot be retried into success
 * inside the same process.
 */
export function ensureProtectedProfileAdmission(): Promise<void> {
  const state = captureProtectedProfile();
  if (!state.profile) return Promise.resolve();
  admission ??= (async () => {
    try {
      const { createConfidentialLocalAdmission } = await import(
        "./confidential-local-admission.ts"
      );
      await createConfidentialLocalAdmission(state.environment);
    } catch (cause) {
      // error-policy:J2 Admission failure stops boot with a typed error.
      throw admissionRejected(cause);
    }
  })();
  return admission;
}

function keyReleaseRejected(purpose: string): ElizaError {
  return new ElizaError(
    "Protected profile requires the pinned dstack key-release path",
    {
      code: "PROTECTED_PROFILE_KEY_RELEASE_REJECTED",
      context: { purpose },
    },
  );
}

/**
 * Under the protected profile only a secure-transport KMS client bound to the
 * pinned dstack evidence adapter may release keys; the local development KDF
 * and generic evidence providers are refused.
 */
export function assertProtectedKeyReleaseClient(
  client: TeeKeyReleaseClient,
  purpose: string,
): void {
  const state = captureProtectedProfile();
  if (!state.profile) return;
  let pinned = false;
  if (client instanceof HttpTeeKeyReleaseClient && client.secureTransport) {
    try {
      pinned = isDstackEvidenceProvider(
        client.attestationProvider,
        resolveDstackEvidenceConfiguration(state.environment),
      );
    } catch {
      // error-policy:J2 Invalid pinned configuration never admits a client.
      pinned = false;
    }
  }
  if (!pinned) throw keyReleaseRejected(purpose);
}

/** Refuse released keys whose trust decision did not come from dstack. */
export function assertProtectedReleaseEvidence(
  release: TeeKeyReleaseResult,
  purpose: string,
): void {
  if (!isProtectedProfileSelected()) return;
  const evidence = release.decision.evidence;
  if (
    !release.decision.trusted ||
    evidence?.provider !== "dstack" ||
    !evidence.freshness?.verifier?.startsWith("dstack-verifier:sha256:")
  ) {
    throw keyReleaseRejected(purpose);
  }
}

/**
 * Apply both protected-profile key-release checks around one client. Ordinary
 * hosts receive the client unchanged.
 */
export function protectedKeyReleaseClient(
  client: TeeKeyReleaseClient,
  purpose: string,
): TeeKeyReleaseClient {
  if (!isProtectedProfileSelected()) return client;
  assertProtectedKeyReleaseClient(client, purpose);
  return {
    async releaseKey(request) {
      const release = await client.releaseKey(request);
      assertProtectedReleaseEvidence(release, purpose);
      return release;
    },
  };
}
