/**
 * Sign→verify round-trip and the tamper matrix, with real Ed25519 keys and
 * real bundles on a tmp filesystem — no mocked crypto. Every tamper case must
 * fail with ITS distinct code, and combined tampering must surface every
 * applicable code in one report (no first-failure-only).
 */

import { sign as cryptoSign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBundle } from "../bundle.ts";
import { canonicalJsonBytes } from "../canonical.ts";
import { EvidenceError, EvidenceValidationError } from "../errors.ts";
import { generateCertificationKeypair, toPrivateKey } from "./keys.ts";
import type { CertificationPayload } from "./schema.ts";
import {
  type CertificationFailureCode,
  type CertificationVerifyReport,
  signCertification,
  verifyCertification,
} from "./sign.ts";

const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const NOW = () => new Date("2026-07-05T12:00:00.000Z");

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-sign-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  bundleDir: string;
  manifestSha256: string;
  artifactAbsPath: string;
}

/** A real finalized bundle with one lane result artifact. */
async function fixtureBundle(
  laneResult: { passed: number; failed: number; skipped: number } = {
    passed: 3,
    failed: 0,
    skipped: 0,
  },
): Promise<Fixture> {
  const sourceDir = tmpDir();
  const sourcePath = path.join(sourceDir, "result.json");
  fs.writeFileSync(sourcePath, JSON.stringify(laneResult));
  const bundle = createBundle({
    rootDir: tmpDir(),
    provenance: {
      commit: COMMIT,
      branch: "feat/sign-test",
      runner: "local",
      tier: "gpu",
      envFingerprint: { tier: "gpu" },
    },
    now: () => new Date("2026-07-05T11:00:00.000Z"),
  });
  await bundle.addArtifact(sourcePath, {
    kind: "report",
    source: "sign-test",
    lane: "server",
    producedBy: "sign.test.ts",
    bundlePath: "lanes/server/result.json",
  });
  const finalized = await bundle.finalize();
  return {
    bundleDir: bundle.dir,
    manifestSha256: finalized.manifestSha256,
    artifactAbsPath: path.join(bundle.dir, "lanes", "server", "result.json"),
  };
}

function payloadFor(
  fixture: Fixture,
  overrides: Partial<CertificationPayload> = {},
): CertificationPayload {
  return {
    schema: 1,
    bundleSha: fixture.manifestSha256,
    commit: COMMIT,
    branch: "feat/sign-test",
    baseRef: "develop",
    tier: "gpu",
    verdicts: [
      {
        subject: "lane:server",
        verdict: "pass",
        evidence: ["lanes/server/result.json"],
      },
    ],
    reviewer: { kind: "agent", id: "fable-reviewer", model: "claude-fable-5" },
    createdAt: "2026-07-05T11:30:00.000Z",
    ...overrides,
  };
}

function codes(report: CertificationVerifyReport): CertificationFailureCode[] {
  return report.failures.map((failure) => failure.code);
}

function writeCert(value: unknown): string {
  const certPath = path.join(tmpDir(), "certification.json");
  fs.writeFileSync(certPath, canonicalJsonBytes(value));
  return certPath;
}

describe("signCertification", () => {
  it("round-trips: sign → verify with bundle, commit, tier, freshness all green", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture),
      keypair.privateKeyPem,
    );
    expect(certification.signature.publicKeyFingerprint).toBe(
      keypair.fingerprint,
    );
    const certPath = writeCert(certification);
    const report = await verifyCertification(certPath, {
      publicKeyPem: keypair.publicKeyPem,
      bundleDir: fixture.bundleDir,
      expectedCommit: COMMIT,
      maxAgeHours: 72,
      requiredTier: "gpu",
      now: NOW,
    });
    expect(report.failures).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.certification?.reviewer.id).toBe("fable-reviewer");
    expect(report.bundle?.ok).toBe(true);
  });

  it("refuses to sign an invalid payload (waived without notes, traversal evidence)", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    expect(() =>
      signCertification(
        payloadFor(fixture, {
          verdicts: [{ subject: "x", verdict: "waived", evidence: [] }],
        }),
        keypair.privateKeyPem,
      ),
    ).toThrow(EvidenceValidationError);
    expect(() =>
      signCertification(
        payloadFor(fixture, {
          verdicts: [
            { subject: "x", verdict: "pass", evidence: ["../escape"] },
          ],
        }),
        keypair.privateKeyPem,
      ),
    ).toThrow(EvidenceValidationError);
  });

  it("refuses to sign with a non-ed25519 key", async () => {
    const fixture = await fixtureBundle();
    expect(() => signCertification(payloadFor(fixture), "not a pem")).toThrow(
      EvidenceError,
    );
  });
});

describe("verifyCertification — tamper matrix", () => {
  it("bad-signature: any payload byte altered after signing", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture),
      keypair.privateKeyPem,
    );
    // Flip a verdict field without re-signing.
    const tampered = {
      ...certification,
      verdicts: [{ ...certification.verdicts[0], subject: "lane:client" }],
    };
    const report = await verifyCertification(writeCert(tampered), {
      publicKeyPem: keypair.publicKeyPem,
      now: NOW,
    });
    expect(codes(report)).toEqual(["bad-signature"]);
  });

  it("bad-signature + verdict-failures: a pass verdict flipped to fail", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture),
      keypair.privateKeyPem,
    );
    const tampered = {
      ...certification,
      verdicts: [{ ...certification.verdicts[0], verdict: "fail" as const }],
    };
    const report = await verifyCertification(writeCert(tampered), {
      publicKeyPem: keypair.publicKeyPem,
      now: NOW,
    });
    expect(codes(report)).toContain("bad-signature");
    expect(codes(report)).toContain("verdict-failures");
  });

  it("bundle-tampered: manifest edited after signing", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture),
      keypair.privateKeyPem,
    );
    const manifestPath = path.join(fixture.bundleDir, "manifest.json");
    fs.appendFileSync(manifestPath, " ");
    const report = await verifyCertification(writeCert(certification), {
      publicKeyPem: keypair.publicKeyPem,
      bundleDir: fixture.bundleDir,
      now: NOW,
    });
    expect(codes(report)).toContain("bundle-tampered");
    expect(report.ok).toBe(false);
  });

  it("bundle-tampered: an artifact swapped out from under the manifest", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture),
      keypair.privateKeyPem,
    );
    fs.writeFileSync(
      fixture.artifactAbsPath,
      JSON.stringify({ passed: 3, failed: 0, skipped: 0, forged: true }),
    );
    const report = await verifyCertification(writeCert(certification), {
      publicKeyPem: keypair.publicKeyPem,
      bundleDir: fixture.bundleDir,
      now: NOW,
    });
    expect(codes(report)).toEqual(["bundle-tampered"]);
    expect(report.failures[0].message).toContain("lanes/server/result.json");
  });

  it("wrong-key: re-signed with a different keypair", async () => {
    const fixture = await fixtureBundle();
    const trusted = generateCertificationKeypair();
    const attacker = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture),
      attacker.privateKeyPem,
    );
    const report = await verifyCertification(writeCert(certification), {
      publicKeyPem: trusted.publicKeyPem,
      now: NOW,
    });
    expect(codes(report)).toEqual(["wrong-key"]);
  });

  it("wrong-key: attacker forges the trusted fingerprint but not the signature", async () => {
    const fixture = await fixtureBundle();
    const trusted = generateCertificationKeypair();
    const attacker = generateCertificationKeypair();
    const forged = signCertification(
      payloadFor(fixture),
      attacker.privateKeyPem,
    );
    // Claiming the trusted fingerprint moves the failure from wrong-key to
    // bad-signature — the crypto check still holds.
    const disguised = {
      ...forged,
      signature: {
        ...forged.signature,
        publicKeyFingerprint: trusted.fingerprint,
      },
    };
    const report = await verifyCertification(writeCert(disguised), {
      publicKeyPem: trusted.publicKeyPem,
      now: NOW,
    });
    expect(codes(report)).toEqual(["bad-signature"]);
  });

  it("stale: createdAt beyond max-age and expiresAt in the past", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const old = signCertification(
      payloadFor(fixture, { createdAt: "2026-07-01T00:00:00.000Z" }),
      keypair.privateKeyPem,
    );
    const oldReport = await verifyCertification(writeCert(old), {
      publicKeyPem: keypair.publicKeyPem,
      maxAgeHours: 72,
      now: NOW,
    });
    expect(codes(oldReport)).toEqual(["stale"]);

    const expired = signCertification(
      payloadFor(fixture, {
        createdAt: "2026-07-04T00:00:00.000Z",
        expiresAt: "2026-07-05T00:00:00.000Z",
      }),
      keypair.privateKeyPem,
    );
    const expiredReport = await verifyCertification(writeCert(expired), {
      publicKeyPem: keypair.publicKeyPem,
      now: NOW,
    });
    expect(codes(expiredReport)).toEqual(["stale"]);
  });

  it("stale: createdAt too far in the future", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const future = signCertification(
      payloadFor(fixture, { createdAt: "2026-07-05T12:10:01.000Z" }),
      keypair.privateKeyPem,
    );
    const report = await verifyCertification(writeCert(future), {
      publicKeyPem: keypair.publicKeyPem,
      now: NOW,
    });
    expect(codes(report)).toEqual(["stale"]);
    expect(report.failures[0].message).toContain("future");
  });

  it("commit-mismatch: certification for a different commit", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture),
      keypair.privateKeyPem,
    );
    const report = await verifyCertification(writeCert(certification), {
      publicKeyPem: keypair.publicKeyPem,
      expectedCommit: "1111111111111111111111111111111111111111",
      now: NOW,
    });
    expect(codes(report)).toEqual(["commit-mismatch"]);
  });

  it("tier-insufficient: cpu cert against a full-tier requirement", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture, { tier: "cpu" }),
      keypair.privateKeyPem,
    );
    const report = await verifyCertification(writeCert(certification), {
      publicKeyPem: keypair.publicKeyPem,
      requiredTier: "full",
      now: NOW,
    });
    expect(codes(report)).toEqual(["tier-insufficient"]);
  });

  it("verdict-failures: a signed failing verdict is still a failing certification", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture, {
        verdicts: [
          {
            subject: "lane:server",
            verdict: "fail",
            evidence: [],
            notes: "2 failures",
          },
        ],
      }),
      keypair.privateKeyPem,
    );
    const report = await verifyCertification(writeCert(certification), {
      publicKeyPem: keypair.publicKeyPem,
      now: NOW,
    });
    expect(codes(report)).toEqual(["verdict-failures"]);
    expect(report.failures[0].message).toContain("lane:server");
  });

  it("verdict-incomplete: signed verdicts must cover the bundle rollup", async () => {
    const fixture = await fixtureBundle({ passed: 0, failed: 1, skipped: 0 });
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture, {
        verdicts: [
          {
            subject: "manual:declared-green",
            verdict: "pass",
            evidence: [],
          },
        ],
      }),
      keypair.privateKeyPem,
    );
    const report = await verifyCertification(writeCert(certification), {
      publicKeyPem: keypair.publicKeyPem,
      bundleDir: fixture.bundleDir,
      now: NOW,
    });
    expect(codes(report)).toEqual(["verdict-incomplete"]);
    expect(report.failures[0].context).toMatchObject({
      missingSubjects: ["lane:server"],
      falsePassSubjects: [],
    });
  });

  it("verdict-incomplete: a mechanically failing subject cannot be signed as pass", async () => {
    const fixture = await fixtureBundle({ passed: 0, failed: 1, skipped: 0 });
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture, {
        verdicts: [
          {
            subject: "lane:server",
            verdict: "pass",
            evidence: ["lanes/server/result.json"],
          },
        ],
      }),
      keypair.privateKeyPem,
    );
    const report = await verifyCertification(writeCert(certification), {
      publicKeyPem: keypair.publicKeyPem,
      bundleDir: fixture.bundleDir,
      now: NOW,
    });
    expect(codes(report)).toEqual(["verdict-incomplete"]);
    expect(report.failures[0].context).toMatchObject({
      missingSubjects: [],
      falsePassSubjects: ["lane:server"],
    });
  });

  it("allows a reviewer to waive a mechanically failing subject with notes", async () => {
    const fixture = await fixtureBundle({ passed: 0, failed: 1, skipped: 0 });
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture, {
        verdicts: [
          {
            subject: "lane:server",
            verdict: "waived",
            evidence: ["lanes/server/result.json"],
            notes: "known flaky lane accepted by release owner",
          },
        ],
      }),
      keypair.privateKeyPem,
    );
    const report = await verifyCertification(writeCert(certification), {
      publicKeyPem: keypair.publicKeyPem,
      bundleDir: fixture.bundleDir,
      now: NOW,
    });
    expect(report.ok).toBe(true);
    expect(report.rollup?.verdicts[0].subject).toBe("lane:server");
    expect(report.rollup?.verdicts[0].verdict).toBe("fail");
  });

  it("schema-invalid: waived-without-notes signed by hand cannot verify clean", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    // Bypass signCertification's validation to simulate a hostile signer.
    const rawPayload = payloadFor(fixture, {
      verdicts: [{ subject: "x", verdict: "waived", evidence: [] }],
    });
    const key = toPrivateKey(keypair.privateKeyPem);
    const value = cryptoSign(
      null,
      canonicalJsonBytes(rawPayload),
      key,
    ).toString("base64");
    const cert = {
      ...rawPayload,
      signature: {
        alg: "ed25519",
        publicKeyFingerprint: keypair.fingerprint,
        value,
      },
    };
    const report = await verifyCertification(writeCert(cert), {
      publicKeyPem: keypair.publicKeyPem,
      now: NOW,
    });
    expect(codes(report)).toContain("schema-invalid");
    expect(report.ok).toBe(false);
  });

  it("schema-invalid: unknown top-level field injection breaks the parse", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture),
      keypair.privateKeyPem,
    );
    const injected = { ...certification, waiverOverride: true };
    const report = await verifyCertification(writeCert(injected), {
      publicKeyPem: keypair.publicKeyPem,
      now: NOW,
    });
    expect(codes(report)).toContain("schema-invalid");
    expect(report.ok).toBe(false);
  });

  it("schema-invalid: evidence path traversal in a hand-signed certification", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const rawPayload = payloadFor(fixture, {
      verdicts: [
        { subject: "x", verdict: "pass", evidence: ["../../secrets.pem"] },
      ],
    });
    const key = toPrivateKey(keypair.privateKeyPem);
    const value = cryptoSign(
      null,
      canonicalJsonBytes(rawPayload),
      key,
    ).toString("base64");
    const cert = {
      ...rawPayload,
      signature: {
        alg: "ed25519",
        publicKeyFingerprint: keypair.fingerprint,
        value,
      },
    };
    const report = await verifyCertification(writeCert(cert), {
      publicKeyPem: keypair.publicKeyPem,
      now: NOW,
    });
    expect(codes(report)).toContain("schema-invalid");
  });

  it("unsigned: signature field missing entirely", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const report = await verifyCertification(writeCert(payloadFor(fixture)), {
      publicKeyPem: keypair.publicKeyPem,
      now: NOW,
    });
    expect(codes(report)).toEqual(["unsigned"]);
    // Payload still parsed, so the gate can annotate what WAS claimed.
    expect(report.payload?.commit).toBe(COMMIT);
  });

  it("schema-invalid: unreadable and non-JSON certification files", async () => {
    const keypair = generateCertificationKeypair();
    const missing = await verifyCertification(
      path.join(tmpDir(), "nope.json"),
      { publicKeyPem: keypair.publicKeyPem, now: NOW },
    );
    expect(codes(missing)).toEqual(["schema-invalid"]);
    const garbagePath = path.join(tmpDir(), "garbage.json");
    fs.writeFileSync(garbagePath, "{{{");
    const garbage = await verifyCertification(garbagePath, {
      publicKeyPem: keypair.publicKeyPem,
      now: NOW,
    });
    expect(codes(garbage)).toEqual(["schema-invalid"]);
  });

  it("reports ALL failures together when tampering is combined", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certification = signCertification(
      payloadFor(fixture, {
        tier: "cpu",
        createdAt: "2026-07-01T00:00:00.000Z",
        verdicts: [
          {
            subject: "lane:server",
            verdict: "fail",
            evidence: ["lanes/server/result.json"],
            notes: "red",
          },
        ],
      }),
      keypair.privateKeyPem,
    );
    // Tamper with the bundle too.
    fs.appendFileSync(path.join(fixture.bundleDir, "manifest.json"), " ");
    const report = await verifyCertification(writeCert(certification), {
      publicKeyPem: keypair.publicKeyPem,
      bundleDir: fixture.bundleDir,
      expectedCommit: "2222222222222222222222222222222222222222",
      maxAgeHours: 72,
      requiredTier: "full",
      now: NOW,
    });
    const found = codes(report);
    for (const expected of [
      "bundle-tampered",
      "commit-mismatch",
      "stale",
      "tier-insufficient",
      "verdict-failures",
    ] as const) {
      expect(found).toContain(expected);
    }
    expect(report.ok).toBe(false);
  });

  it("throws (not reports) on a misconfigured trusted public key", async () => {
    const fixture = await fixtureBundle();
    const keypair = generateCertificationKeypair();
    const certPath = writeCert(
      signCertification(payloadFor(fixture), keypair.privateKeyPem),
    );
    await expect(
      verifyCertification(certPath, { publicKeyPem: "not a key", now: NOW }),
    ).rejects.toThrow(EvidenceError);
  });
});
