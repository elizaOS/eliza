/**
 * Simulates capture failure and successful replacement to prove evidence
 * publication never leaves a partial or mixed-generation final directory.
 */

import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginEvidenceTransaction,
  validateEvidenceBundle,
} from "./evidence-bundle.mjs";

const roots = [];
const fingerprint = "a".repeat(64);

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function writeValidBundle(root) {
  const capturedAt = "2026-07-30T20:00:00.000Z";
  const artifacts = {
    "after-desktop.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    "after-mobile.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    "browser-log.json": Buffer.from(
      `${JSON.stringify({
        baseUrl: "http://127.0.0.1:4466",
        buildFingerprint: fingerprint,
        capturedAt,
        console: [],
        mode: "local",
        network: [],
        pageErrors: [],
        requestFailures: [],
      })}\n`,
    ),
    "site-verification.json": Buffer.from(
      `${JSON.stringify({
        buildFingerprint: fingerprint,
        capturedAt,
        mode: "local",
      })}\n`,
    ),
    "walkthrough.mp4": Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70,
    ]),
  };
  for (const [name, contents] of Object.entries(artifacts)) {
    writeFileSync(join(root, name), contents);
  }
  writeFileSync(
    join(root, "manifest.json"),
    `${JSON.stringify({
      schemaVersion: "1",
      artifacts: Object.entries(artifacts).map(([name, contents]) => ({
        name,
        sha256: sha256(contents),
      })),
      buildFingerprint: fingerprint,
      capturedAt,
      mode: "local",
      validation: {
        consoleErrors: 0,
        failedFirstPartyRequests: 0,
        failedFirstPartyResponses: 0,
        pageErrors: 0,
      },
    })}\n`,
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("evidence bundle transaction", () => {
  it("preserves the prior complete bundle after a simulated mid-run failure", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-evidence-failure-"));
    roots.push(root);
    const finalRoot = join(root, "evidence");
    mkdirSync(finalRoot);
    writeValidBundle(finalRoot);
    const priorManifest = readFileSync(join(finalRoot, "manifest.json"));
    const transaction = beginEvidenceTransaction(finalRoot);

    expect(() => {
      try {
        writeFileSync(
          join(transaction.stagingRoot, "after-desktop.jpg"),
          "partial",
        );
        throw new Error("simulated browser failure");
      } finally {
        transaction.abort();
      }
    }).toThrow("simulated browser failure");

    expect(
      validateEvidenceBundle(finalRoot, {
        buildFingerprint: fingerprint,
        mode: "local",
      }),
    ).toMatchObject({ artifactCount: 5 });
    expect(readFileSync(join(finalRoot, "manifest.json"))).toEqual(
      priorManifest,
    );
    expect(
      readdirSync(root).filter((name) => name.includes("staging")),
    ).toEqual([]);
  });

  it("validates and replaces the prior bundle without retaining stale files", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-evidence-success-"));
    roots.push(root);
    const finalRoot = join(root, "evidence");
    mkdirSync(finalRoot);
    writeFileSync(join(finalRoot, "stale.txt"), "stale\n");
    const transaction = beginEvidenceTransaction(finalRoot);
    writeValidBundle(transaction.stagingRoot);

    expect(
      validateEvidenceBundle(transaction.stagingRoot, {
        buildFingerprint: fingerprint,
        mode: "local",
      }),
    ).toMatchObject({ artifactCount: 5, mode: "local" });
    transaction.publish();

    expect(readdirSync(finalRoot).sort()).toEqual([
      "after-desktop.jpg",
      "after-mobile.jpg",
      "browser-log.json",
      "manifest.json",
      "site-verification.json",
      "walkthrough.mp4",
    ]);
    expect(readdirSync(root)).toEqual(["evidence"]);
  });

  it("rejects a digest mismatch before publication", () => {
    const root = mkdtempSync(join(tmpdir(), "eliza-evidence-digest-"));
    roots.push(root);
    const transaction = beginEvidenceTransaction(join(root, "evidence"));
    writeValidBundle(transaction.stagingRoot);
    writeFileSync(
      join(transaction.stagingRoot, "after-desktop.jpg"),
      Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]),
    );

    expect(() =>
      validateEvidenceBundle(transaction.stagingRoot, {
        buildFingerprint: fingerprint,
        mode: "local",
      }),
    ).toThrow("does not match its digest");
    transaction.abort();
  });
});
