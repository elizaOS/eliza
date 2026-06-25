// Fixture-based tests for the OS runtime-evidence bridge (plan OS-2, contract
// "Runtime Evidence Bridge"). The bridge transforms a platform quote into the
// normalized TeeEvidence document and asserts the runtime measurements bind to
// the signed golden tee-measurements set before emitting.
//
// Two things are verified end-to-end against checked-in fixtures:
//   1. The GOLDEN fixture binds to the golden manifest measurements and the
//      resulting document is accepted by the agent-side normalizeTeeEvidence
//      (the consumer contract in packages/agent/src/services/tee-evidence.ts).
//   2. The TAMPERED fixture fails the binding assertion (fail-closed).
//
// Runner: this file uses `node --test`, the documented runner for OS scripts
// (packages/os/docs/beta-release-manifest.md). `bun test` is unstable for these
// .mjs fixtures in this environment, so node's runner is canonical:
//   node --test packages/os/scripts/__tests__/tee-evidence-bridge.test.mjs
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readJson } from "../os-release-lib.mjs";
import {
  buildBoundEvidence,
  goldenMeasurementsOf,
} from "../tee-evidence-bridge.mjs";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../../..", import.meta.url)),
);
const confidentialManifestPath = path.join(
  repoRoot,
  "packages/os/release/confidential-2026-05-21/manifest.json",
);
const goldenFixturePath = path.join(
  repoRoot,
  "packages/os/release/schema/tee-evidence.mock.json",
);
const tamperedFixturePath = path.join(
  repoRoot,
  "packages/os/release/schema/tee-evidence.tampered.mock.json",
);

// The agent consumer (packages/agent/src/services/tee-evidence.ts) ships only as
// a TypeScript source; its compiled form lives in the gitignored dist/ build.
// When the build is present we exercise the real normalizeTeeEvidence so the
// bridge output is checked against the actual downstream contract. When it is
// absent (fresh checkout, no build) we fall back to an inline assertion of the
// same acceptance rules so the consumer contract is still enforced.
const agentEvidenceDist = path.join(
  repoRoot,
  "packages/agent/dist/services/tee-evidence.js",
);

async function loadAgentNormalizer() {
  try {
    await access(agentEvidenceDist);
  } catch {
    return null;
  }
  const mod = await import(`file://${agentEvidenceDist}`);
  if (typeof mod.normalizeTeeEvidence !== "function") {
    throw new Error("agent dist build is missing normalizeTeeEvidence export");
  }
  return mod.normalizeTeeEvidence;
}

// Inline replica of the required-field acceptance rules enforced by the agent's
// normalizeTeeEvidence: `kind` is a required non-empty string, measurements must
// be a string map, and claims values must be boolean. Throws on violation.
function assertAcceptedByConsumerContract(evidence) {
  assert.ok(
    evidence && typeof evidence === "object" && !Array.isArray(evidence),
    "evidence must be an object",
  );
  assert.equal(
    typeof evidence.kind === "string" && evidence.kind.trim().length > 0,
    true,
    "evidence.kind must be a non-empty string",
  );
  if (evidence.measurements !== undefined) {
    assert.equal(
      typeof evidence.measurements === "object" &&
        !Array.isArray(evidence.measurements),
      true,
      "evidence.measurements must be an object",
    );
    for (const [name, digest] of Object.entries(evidence.measurements)) {
      assert.equal(
        typeof digest,
        "string",
        `measurement ${name} must be a string`,
      );
    }
  }
  if (evidence.claims !== undefined) {
    for (const [claim, value] of Object.entries(evidence.claims)) {
      assert.equal(typeof value, "boolean", `claim ${claim} must be boolean`);
    }
  }
}

test("golden fixture binds to golden measurements and maps every field", async () => {
  const manifest = await readJson(confidentialManifestPath);
  const golden = goldenMeasurementsOf(manifest);
  const evidence = await readJson(goldenFixturePath);

  const bound = buildBoundEvidence(evidence, golden);

  // Specific, load-bearing field mappings (not just "did not throw").
  assert.equal(bound.kind, "dstack");
  assert.equal(bound.provider, "dstack");
  assert.equal(bound.hardwareVendor, "intel");
  assert.equal(bound.securityVersion, 7);
  assert.equal(
    bound.measurements.os,
    "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  );
  assert.equal(bound.measurements.os, golden.os);
  assert.equal(
    bound.reportData,
    "sha256:6666666666666666666666666666666666666666666666666666666666666666",
  );
  assert.equal(bound.claims.npuProtected, true);
  assert.equal(bound.claims.ioProtected, true);
  assert.equal(bound.freshness.verifier, "eliza-local-verifier");

  // Every golden measurement must be present and equal in the bound output.
  for (const [name, digest] of Object.entries(golden)) {
    assert.equal(
      bound.measurements[name],
      digest,
      `bound measurement ${name} must equal golden`,
    );
  }
});

test("golden bound evidence is accepted by the agent normalizeTeeEvidence contract", async () => {
  const manifest = await readJson(confidentialManifestPath);
  const golden = goldenMeasurementsOf(manifest);
  const evidence = await readJson(goldenFixturePath);
  const bound = buildBoundEvidence(evidence, golden);

  const normalize = await loadAgentNormalizer();
  if (normalize) {
    const normalized = normalize(bound);
    // Round-trip preserves the load-bearing fields the agent provider reads.
    assert.equal(normalized.kind, "dstack");
    assert.equal(normalized.measurements.os, golden.os);
    assert.equal(normalized.reportData, bound.reportData);
    assert.equal(normalized.claims.npuProtected, true);
    assert.equal(normalized.securityVersion, 7);
  } else {
    assertAcceptedByConsumerContract(bound);
  }
});

test("tampered fixture fails the runtime-vs-golden binding (fail-closed)", async () => {
  const manifest = await readJson(confidentialManifestPath);
  const golden = goldenMeasurementsOf(manifest);
  const tampered = await readJson(tamperedFixturePath);

  // The tampered fixture mutates the `os` measurement away from golden.
  assert.notEqual(tampered.measurements.os, golden.os);

  assert.throws(
    () => buildBoundEvidence(tampered, golden),
    /measurement-mismatch: runtime os does not equal golden/,
  );
});

test("a malformed runtime digest is rejected before binding", async () => {
  const manifest = await readJson(confidentialManifestPath);
  const golden = goldenMeasurementsOf(manifest);
  const evidence = await readJson(goldenFixturePath);
  const broken = {
    ...evidence,
    measurements: { ...evidence.measurements, os: "not-a-digest" },
  };

  assert.throws(
    () => buildBoundEvidence(broken, golden),
    /runtime measurement os is not a sha256 digest/,
  );
});
