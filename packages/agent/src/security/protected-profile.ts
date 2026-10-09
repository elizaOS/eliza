/**
 * Selects the protected host profile from the process environment captured at
 * entry. Once selected, local dstack admission must succeed before secrets,
 * listeners or plugins load, and dev/test trust substitutes are refused.
 * Config files and API writes cannot select, clear or relax the profile.
 */
import { ElizaError } from "@elizaos/core";
import { isDstackEvidenceProvider } from "../services/tee-dstack-evidence.ts";
import { DstackGuestKeyReleaseClient } from "../services/tee-dstack-key-release.ts";
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

/** Exact class instances only: a subclass could override `releaseKey`. */
function isExactInstance<T extends object>(
  value: object,
  ctor: { prototype: T },
): value is T {
  return (
    Object.getPrototypeOf(value) === ctor.prototype &&
    !Object.hasOwn(value, "releaseKey")
  );
}

/**
 * Under the protected profile only two clients may release keys, both bound to
 * the pinned dstack evidence adapter: a secure-transport KMS client, or the
 * dstack guest `GetKey` client pinned to the configured socket, app id and KMS
 * root key. The local development KDF and generic providers are refused.
 */
export function assertProtectedKeyReleaseClient(
  client: TeeKeyReleaseClient,
  purpose: string,
): void {
  const state = captureProtectedProfile();
  if (!state.profile) return;
  let pinned = false;
  try {
    const config = resolveDstackEvidenceConfiguration(state.environment);
    if (
      isExactInstance(client, HttpTeeKeyReleaseClient) &&
      client.secureTransport
    ) {
      pinned = isDstackEvidenceProvider(client.attestationProvider, config);
    } else if (isExactInstance(client, DstackGuestKeyReleaseClient)) {
      pinned =
        config.kmsRootPublicKey !== undefined &&
        client.kmsRootPublicKey === config.kmsRootPublicKey.toLowerCase() &&
        client.pinnedAppId === config.appId.toLowerCase() &&
        client.socketPath === config.socketPath &&
        isDstackEvidenceProvider(client.attestationProvider, config);
    }
  } catch {
    // error-policy:J2 Invalid pinned configuration never admits a client.
    pinned = false;
  }
  if (!pinned) throw keyReleaseRejected(purpose);
}

/**
 * Refuse released keys unless this process's own appraisal of its fresh,
 * request-bound evidence came from the pinned dstack verifier. A key source's
 * decision (for example a KMS response) is never accepted as that proof.
 */
export function assertProtectedReleaseEvidence(
  release: TeeKeyReleaseResult,
  purpose: string,
): void {
  if (!isProtectedProfileSelected()) return;
  const evidence = release.decision.evidence;
  if (
    !release.decision.trusted ||
    evidence?.provider !== "dstack" ||
    !evidence.freshness?.verifier?.startsWith("dstack-verifier:sha256:") ||
    !evidence.freshness.nonce ||
    !evidence.reportData ||
    (release.keySourceDecision !== undefined &&
      release.keySourceDecision.trusted !== true)
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
