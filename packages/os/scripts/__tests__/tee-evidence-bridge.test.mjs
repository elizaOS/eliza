/** Exercises fixture evidence binding against the real Eliza agent normalizer and CLI boundary. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveElizaSourceRoot } from "../eliza-source.mjs";
import { readJson } from "../os-release-lib.mjs";
import {
  buildBoundEvidence,
  goldenMeasurementsOf,
} from "../tee-evidence-bridge.mjs";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const confidentialManifestPath = path.join(
  repoRoot,
  "scripts/__tests__/fixtures/confidential-manifest.json",
);
const goldenFixturePath = path.join(
  repoRoot,
  "scripts/__tests__/fixtures/tee-evidence.json",
);
const tamperedFixturePath = path.join(
  repoRoot,
  "scripts/__tests__/fixtures/tee-evidence-tampered.json",
);

const { normalizeTeeEvidence } = await import(
  pathToFileURL(
    path.join(
      resolveElizaSourceRoot(),
      "packages/agent/src/services/tee-evidence.ts",
    ),
  ).href
);

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

  {
    const normalized = normalizeTeeEvidence(bound);
    // Round-trip preserves the load-bearing fields the agent provider reads.
    assert.equal(normalized.kind, "dstack");
    assert.equal(normalized.measurements.os, golden.os);
    assert.equal(normalized.reportData, bound.reportData);
    assert.equal(normalized.claims.npuProtected, true);
    assert.equal(normalized.securityVersion, 7);
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

test("mock evidence CLI requires an explicit destination and never chooses runtime state", () => {
  for (const args of [
    [],
    ["--quote-source", "mock"],
    [
      "--quote-source",
      "mock",
      "--golden",
      confidentialManifestPath,
      "--evidence",
      goldenFixturePath,
    ],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts/tee-evidence-bridge.mjs"), ...args],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /quote collection|requires explicit/);
  }
});
