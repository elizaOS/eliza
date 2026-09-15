/** Exercises sandbox snapshot failure classification with real in-memory KMS failures. Lifecycle prototype simulations are not installed in this suite. */
/**
 * Covers sandbox lifecycle, state transfer, recovery, and upgrade invariants
 * using deterministic repository and provider fixtures.
 */

import { describe, expect, test } from "bun:test";
import { KeyNotFoundError, KmsError } from "@elizaos/core/security/kms";
import {
  realAeadDecryptError,
  realKeyRotatedAwayError,
} from ".././eliza-sandbox/test-support/kms.js";

// Snapshot-degrade error classification (`isUnrecoverableSnapshotError`), proven
// against real core KMS errors produced by the crypto stack — the
// precise crypto-vs-transient distinction the degrade path keys on.
describe("isUnrecoverableSnapshotError (permanent-vs-transient classification)", () => {
  test("classifies a real KeyNotFoundError (memory-KMS key rotated away) as unrecoverable", async () => {
    const { isUnrecoverableSnapshotError } = await import(".././eliza-sandbox.ts?actual");
    const err = await realKeyRotatedAwayError();
    // The exact prod incident: the memory backend restart orphaned the key.
    expect(err).toBeInstanceOf(KeyNotFoundError);
    expect(isUnrecoverableSnapshotError(err)).toBe(true);
  });

  test("classifies a real AeadError (auth-tag failure) as unrecoverable", async () => {
    const { isUnrecoverableSnapshotError } = await import(".././eliza-sandbox.ts?actual");
    const err = await realAeadDecryptError();
    expect(err.name).toBe("AeadError");
    expect(isUnrecoverableSnapshotError(err)).toBe(true);
  });

  test("classifies permanent snapshot HTTP rejections (401/403/404/410) as unrecoverable", async () => {
    const { isUnrecoverableSnapshotError } = await import(".././eliza-sandbox.ts?actual");
    // The exact HQ 14308 incident string, as pushState throws it (status +
    // first 200 bytes of the response body).
    expect(
      isUnrecoverableSnapshotError(
        new Error('State restore failed: HTTP 401 {"error":"Unauthorized"}'),
      ),
    ).toBe(true);
    expect(isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 403 "))).toBe(true);
    expect(
      isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 404 Not Found")),
    ).toBe(true);
    expect(isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 410 Gone"))).toBe(
      true,
    );
    // fetchSnapshotState's shape (no body suffix). Its 404 is mapped to the
    // SNAPSHOT_ENDPOINT_UNSUPPORTED sentinel before ever surfacing, but the
    // auth statuses surface verbatim.
    expect(isUnrecoverableSnapshotError(new Error("Snapshot fetch failed: HTTP 401"))).toBe(true);
    expect(isUnrecoverableSnapshotError(new Error("Snapshot fetch failed: HTTP 403"))).toBe(true);
    expect(isUnrecoverableSnapshotError(new Error("Snapshot fetch failed: HTTP 410"))).toBe(true);
  });

  test("does NOT classify transient snapshot HTTP failures — those must retry", async () => {
    const { isUnrecoverableSnapshotError } = await import(".././eliza-sandbox.ts?actual");
    // 5xx (container mid-boot / overloaded), 408 (timeout), 429 (throttled):
    // all can heal on the next attempt, so degrading would discard restorable
    // state.
    expect(
      isUnrecoverableSnapshotError(
        new Error("State restore failed: HTTP 500 Internal Server Error"),
      ),
    ).toBe(false);
    expect(
      isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 502 Bad Gateway")),
    ).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 503 "))).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 408 "))).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("State restore failed: HTTP 429 "))).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("Snapshot fetch failed: HTTP 500"))).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("Snapshot fetch failed: HTTP 503"))).toBe(false);
    // #18228: a diagnostic body suffix must not change transient-vs-permanent
    // classification — the regex is anchored at the status prefix.
    expect(
      isUnrecoverableSnapshotError(
        new Error("Snapshot fetch failed: HTTP 500 Durable Object storage quota exceeded"),
      ),
    ).toBe(false);
  });

  test("matches only this file's snapshot throw shapes — anchored, exact status", async () => {
    const { isUnrecoverableSnapshotError, SNAPSHOT_ENDPOINT_UNSUPPORTED } = await import(
      ".././eliza-sandbox.ts?actual"
    );
    // Network-level fetch failures carry no HTTP status and must propagate.
    expect(isUnrecoverableSnapshotError(new TypeError("fetch failed"))).toBe(false);
    // A message that merely EMBEDS the wrapper (e.g. the markError re-wrap) is
    // not the raw restore-path error the degrade classifies.
    expect(
      isUnrecoverableSnapshotError(
        new Error(
          'Provisioning failed after 1 attempt (not retryable): State restore failed: HTTP 401 {"error":"Unauthorized"}',
        ),
      ),
    ).toBe(false);
    // The "image has no snapshot endpoint" sentinel is a benign skip elsewhere,
    // never a degrade.
    expect(isUnrecoverableSnapshotError(new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED))).toBe(false);
    expect(isUnrecoverableSnapshotError(new Error("Sandbox is not running"))).toBe(false);
  });

  test("does NOT classify transient / non-crypto failures as unrecoverable", async () => {
    const { isUnrecoverableSnapshotError } = await import(".././eliza-sandbox.ts?actual");
    // A DB/network blip, a base Steward KmsError (HTTP 5xx transient), and
    // non-Errors must all propagate — degrading on them would discard state a
    // retry would have restored.
    expect(isUnrecoverableSnapshotError(new Error("connection terminated unexpectedly"))).toBe(
      false,
    );
    expect(
      isUnrecoverableSnapshotError(
        new KmsError("Steward KMS decrypt failed (503 Service Unavailable)"),
      ),
    ).toBe(false);
    expect(isUnrecoverableSnapshotError("AEAD decrypt failed")).toBe(false);
    expect(isUnrecoverableSnapshotError(null)).toBe(false);
    expect(isUnrecoverableSnapshotError(undefined)).toBe(false);
  });
});

// Snapshot PRUNE-gating classification (`isPermanentlyLostSnapshot`, #15274).
// A strict SUBSET of `isUnrecoverableSnapshotError`: an auth 401/403 is
// unrecoverable for THIS provision (boot fresh) but the snapshot is NOT
// permanently lost — a token-corrected resume (#15263) can still restore it —
// so it must NEVER gate a `pruneBackups(agentId, 0)`. Only crypto-loss and
// HTTP 404/410 are permanently lost and safe to prune.
describe("isPermanentlyLostSnapshot (prune-vs-preserve gating)", () => {
  test("classifies crypto-loss shapes (KeyNotFoundError / AeadError) as permanently lost", async () => {
    const { isPermanentlyLostSnapshot } = await import(".././eliza-sandbox.ts?actual");
    const keyGone = await realKeyRotatedAwayError();
    expect(keyGone).toBeInstanceOf(KeyNotFoundError);
    expect(isPermanentlyLostSnapshot(keyGone)).toBe(true);
    const corrupt = await realAeadDecryptError();
    expect(corrupt.name).toBe("AeadError");
    expect(isPermanentlyLostSnapshot(corrupt)).toBe(true);
  });

  test("classifies HTTP 404/410 (snapshot gone) as permanently lost — safe to prune", async () => {
    const { isPermanentlyLostSnapshot } = await import(".././eliza-sandbox.ts?actual");
    expect(isPermanentlyLostSnapshot(new Error("State restore failed: HTTP 404 Not Found"))).toBe(
      true,
    );
    expect(isPermanentlyLostSnapshot(new Error("State restore failed: HTTP 410 Gone"))).toBe(true);
    expect(isPermanentlyLostSnapshot(new Error("Snapshot fetch failed: HTTP 410"))).toBe(true);
  });

  test("does NOT classify auth 401/403 as permanently lost — recoverable, must PRESERVE the chain (#15274)", async () => {
    const { isPermanentlyLostSnapshot, isUnrecoverableSnapshotError } = await import(
      ".././eliza-sandbox.ts?actual"
    );
    // The exact HQ 14308 incident string. It IS unrecoverable-for-this-provision
    // (degrade to fresh boot) but NOT permanently lost: PR #15263 shows the 401
    // was a healthy container missing the agent token, which a corrected resume
    // restores. Pruning here = silent permanent data loss.
    const auth401 = new Error('State restore failed: HTTP 401 {"error":"Unauthorized"}');
    expect(isUnrecoverableSnapshotError(auth401)).toBe(true);
    expect(isPermanentlyLostSnapshot(auth401)).toBe(false);
    const auth403 = new Error("State restore failed: HTTP 403 ");
    expect(isUnrecoverableSnapshotError(auth403)).toBe(true);
    expect(isPermanentlyLostSnapshot(auth403)).toBe(false);
    expect(isPermanentlyLostSnapshot(new Error("Snapshot fetch failed: HTTP 401"))).toBe(false);
    expect(isPermanentlyLostSnapshot(new Error("Snapshot fetch failed: HTTP 403"))).toBe(false);
  });

  test("does NOT classify transient / non-matching errors as permanently lost", async () => {
    const { isPermanentlyLostSnapshot } = await import(".././eliza-sandbox.ts?actual");
    // Transient HTTP and network/DB errors were never unrecoverable to begin
    // with; they must never prune.
    expect(
      isPermanentlyLostSnapshot(new Error("State restore failed: HTTP 500 Internal Server Error")),
    ).toBe(false);
    expect(isPermanentlyLostSnapshot(new Error("State restore failed: HTTP 503 "))).toBe(false);
    expect(isPermanentlyLostSnapshot(new Error("connection terminated unexpectedly"))).toBe(false);
    expect(isPermanentlyLostSnapshot(new TypeError("fetch failed"))).toBe(false);
    expect(isPermanentlyLostSnapshot("AEAD decrypt failed")).toBe(false);
    expect(isPermanentlyLostSnapshot(null)).toBe(false);
    expect(isPermanentlyLostSnapshot(undefined)).toBe(false);
  });
});
