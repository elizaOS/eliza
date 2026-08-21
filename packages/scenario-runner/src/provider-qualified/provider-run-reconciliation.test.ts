/**
 * Exercises the real Ed25519 reconciliation envelope, including stale journal,
 * wrong-action, expiry, and key-substitution failures. The harness signs only
 * synthetic journal snapshots and never represents provider evidence.
 */

import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createProviderRunReconciliationPayload,
  providerRunJournalSha256,
  providerRunReconciliationSigningBytes,
  verifySignedProviderRunReconciliation,
} from "./provider-run-reconciliation.ts";
import { providerObserverKeyId } from "./qualification.ts";

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spkiPem = publicKey.export({ type: "spki", format: "pem" });
  const keyId = providerObserverKeyId(spkiPem);
  const journal = {
    schema: "eliza.external-provider-canary-run-journal.v2",
    manifestSha256: "a".repeat(64),
    status: "consumed",
    phase: "manifest-consumed",
  };
  const payload = createProviderRunReconciliationPayload({
    journalKind: "external-canary",
    journalSha256: providerRunJournalSha256(journal),
    targetSha256: "a".repeat(64),
    action: "recover-staged-publication",
    issuedAtIso: "2026-08-20T00:00:00.000Z",
    expiresAtIso: "2026-08-20T00:10:00.000Z",
    nonce: "synthetic-reconciliation-001",
  });
  const envelope = {
    payload,
    signer: { keyId, algorithm: "ed25519" as const },
    signature: sign(
      null,
      providerRunReconciliationSigningBytes(payload),
      privateKey,
    ).toString("base64url"),
  };
  return {
    journal,
    envelope,
    pins: [{ keyId, algorithm: "ed25519" as const, spkiPem }],
  };
}

describe("provider run reconciliation", () => {
  it("accepts one exact, fresh, authority-signed journal action", () => {
    const test = fixture();
    expect(
      verifySignedProviderRunReconciliation({
        value: test.envelope,
        journal: test.journal,
        expectedJournalKind: "external-canary",
        expectedTargetSha256: "a".repeat(64),
        expectedAction: "recover-staged-publication",
        authorityPins: test.pins,
        now: new Date("2026-08-20T00:05:00.000Z"),
      }),
    ).toEqual(test.envelope);
  });

  it("rejects replay after any journal transition", () => {
    const test = fixture();
    expect(() =>
      verifySignedProviderRunReconciliation({
        value: test.envelope,
        journal: { ...test.journal, phase: "publication-committed" },
        expectedJournalKind: "external-canary",
        expectedTargetSha256: "a".repeat(64),
        expectedAction: "recover-staged-publication",
        authorityPins: test.pins,
        now: new Date("2026-08-20T00:05:00.000Z"),
      }),
    ).toThrow(/stale/);
  });

  it("rejects action substitution and expired approval", () => {
    const test = fixture();
    expect(() =>
      verifySignedProviderRunReconciliation({
        value: test.envelope,
        journal: test.journal,
        expectedJournalKind: "external-canary",
        expectedTargetSha256: "a".repeat(64),
        expectedAction: "acknowledge-provider-reconciled",
        authorityPins: test.pins,
        now: new Date("2026-08-20T00:05:00.000Z"),
      }),
    ).toThrow(/action/);
    expect(() =>
      verifySignedProviderRunReconciliation({
        value: test.envelope,
        journal: test.journal,
        expectedJournalKind: "external-canary",
        expectedTargetSha256: "a".repeat(64),
        expectedAction: "recover-staged-publication",
        authorityPins: test.pins,
        now: new Date("2026-08-20T00:11:00.000Z"),
      }),
    ).toThrow(/expired/);
  });

  it("rejects a cryptographically valid signature from an unpinned key", () => {
    const test = fixture();
    const other = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    });
    expect(() =>
      verifySignedProviderRunReconciliation({
        value: test.envelope,
        journal: test.journal,
        expectedJournalKind: "external-canary",
        expectedTargetSha256: "a".repeat(64),
        expectedAction: "recover-staged-publication",
        authorityPins: [
          {
            keyId: providerObserverKeyId(other),
            algorithm: "ed25519",
            spkiPem: other,
          },
        ],
        now: new Date("2026-08-20T00:05:00.000Z"),
      }),
    ).toThrow(/not an authorized/);
  });
});
