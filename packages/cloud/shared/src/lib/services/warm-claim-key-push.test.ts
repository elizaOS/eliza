/**
 * Warm-pool claim -> inference-credential re-key body builder (F0).
 *
 * A warm-pool container boots under the sentinel pool org with a cloud
 * inference key scoped to THAT org; after a claim the running container must be
 * re-credentialed to the CLAIMING user's org or every reply is the "key isn't
 * authorized for inference" fallback. This builder produces the
 * `POST /api/cloud/login/persist` body that ships the new key. These tests pin:
 *   - the body carries the key + org (+ optional user) and always forces
 *     inference ON (so the claimed agent can infer even if the container's
 *     persisted billing header does not report cloud-proxy);
 *   - a missing key or org yields null (caller skips the push, no partial
 *     re-credential);
 *   - the safe log prefix truncates and never exposes the full secret.
 */

import { describe, expect, test } from "bun:test";
import {
  buildWarmClaimKeyPushBody,
  hasReadyWarmClaimCredential,
  safeKeyPrefix,
  WARM_CLAIM_KEY_LOG_PREFIX_LEN,
} from "./warm-claim-key-push";

describe("warm-claim credential readiness", () => {
  const claimedAt = new Date("2026-07-23T00:00:00.000Z");

  test("requires server-owned ready state and an attestation timestamp", () => {
    expect(
      hasReadyWarmClaimCredential({
        claimed_at: claimedAt,
        warm_claim_credential_state: "pending",
        warm_claim_attested_at: null,
        warm_claim_source_pool_id: "44444444-4444-4444-8444-444444444444",
        warm_claim_key_fingerprint: null,
        warm_claim_attested_environment_revision: null,
        environment_revision: 2,
      }),
    ).toBe(false);
    expect(
      hasReadyWarmClaimCredential({
        claimed_at: claimedAt,
        warm_claim_credential_state: "ready",
        warm_claim_attested_at: null,
        warm_claim_source_pool_id: null,
        warm_claim_key_fingerprint: "deadbeefdeadbeef",
        warm_claim_attested_environment_revision: 2,
        environment_revision: 2,
      }),
    ).toBe(false);
    expect(
      hasReadyWarmClaimCredential({
        claimed_at: claimedAt,
        warm_claim_credential_state: "ready",
        warm_claim_attested_at: claimedAt,
        warm_claim_source_pool_id: "44444444-4444-4444-8444-444444444444",
        warm_claim_key_fingerprint: "deadbeefdeadbeef",
        warm_claim_attested_environment_revision: 2,
        environment_revision: 2,
      }),
    ).toBe(false);
    expect(
      hasReadyWarmClaimCredential({
        claimed_at: claimedAt,
        warm_claim_credential_state: "ready",
        warm_claim_attested_at: claimedAt,
        warm_claim_source_pool_id: null,
        warm_claim_key_fingerprint: "deadbeefdeadbeef",
        warm_claim_attested_environment_revision: 2,
        environment_revision: 2,
      }),
    ).toBe(true);
    expect(
      hasReadyWarmClaimCredential({
        claimed_at: claimedAt,
        warm_claim_credential_state: "ready",
        warm_claim_attested_at: claimedAt,
        warm_claim_source_pool_id: null,
        warm_claim_key_fingerprint: "deadbeefdeadbeef",
        warm_claim_attested_environment_revision: 2,
        environment_revision: 3,
      }),
    ).toBe(false);
  });

  test("does not gate cold-provisioned rows", () => {
    expect(
      hasReadyWarmClaimCredential({
        claimed_at: null,
        warm_claim_credential_state: null,
        warm_claim_attested_at: null,
        warm_claim_source_pool_id: null,
        warm_claim_key_fingerprint: null,
        warm_claim_attested_environment_revision: null,
        environment_revision: 0,
      }),
    ).toBe(true);
  });
});

describe("buildWarmClaimKeyPushBody", () => {
  test("builds a body that forces inference on, with org + user", () => {
    const body = buildWarmClaimKeyPushBody({
      apiKey: "eliza_deadbeefcafef00d",
      organizationId: "org-user-1",
      userId: "user-1",
    });
    expect(body).toEqual({
      apiKey: "eliza_deadbeefcafef00d",
      organizationId: "org-user-1",
      userId: "user-1",
      forceInferenceEnabled: true,
    });
  });

  test("omits userId when absent but still forces inference on", () => {
    const body = buildWarmClaimKeyPushBody({
      apiKey: "eliza_key",
      organizationId: "org-1",
    });
    expect(body).toEqual({
      apiKey: "eliza_key",
      organizationId: "org-1",
      forceInferenceEnabled: true,
    });
    expect(body && "userId" in body).toBe(false);
  });

  test("trims whitespace on key, org, and user", () => {
    const body = buildWarmClaimKeyPushBody({
      apiKey: "  eliza_key  ",
      organizationId: " org-1 ",
      userId: " user-1 ",
    });
    expect(body).toEqual({
      apiKey: "eliza_key",
      organizationId: "org-1",
      userId: "user-1",
      forceInferenceEnabled: true,
    });
  });

  test("returns null when the api key is missing/blank (no partial re-key)", () => {
    expect(buildWarmClaimKeyPushBody({ apiKey: null, organizationId: "org-1" })).toBeNull();
    expect(buildWarmClaimKeyPushBody({ apiKey: "   ", organizationId: "org-1" })).toBeNull();
    expect(buildWarmClaimKeyPushBody({ apiKey: undefined, organizationId: "org-1" })).toBeNull();
  });

  test("returns null when the org is missing/blank", () => {
    expect(buildWarmClaimKeyPushBody({ apiKey: "eliza_key", organizationId: null })).toBeNull();
    expect(buildWarmClaimKeyPushBody({ apiKey: "eliza_key", organizationId: "  " })).toBeNull();
  });
});

describe("safeKeyPrefix", () => {
  test("truncates to the fixed prefix length and appends an ellipsis", () => {
    const key = "eliza_" + "0123456789abcdefabcdef";
    const prefix = safeKeyPrefix(key);
    expect(prefix.endsWith("…")).toBe(true);
    // The visible portion is exactly WARM_CLAIM_KEY_LOG_PREFIX_LEN chars.
    expect(prefix.slice(0, -1)).toBe(key.slice(0, WARM_CLAIM_KEY_LOG_PREFIX_LEN));
    // The full secret NEVER appears in the safe prefix.
    expect(prefix).not.toContain("abcdefabcdef");
    expect(key.startsWith(prefix.slice(0, -1))).toBe(true);
  });

  test("does not throw on a key shorter than the prefix length", () => {
    expect(safeKeyPrefix("eliza_x")).toBe("eliza_x…");
  });
});
