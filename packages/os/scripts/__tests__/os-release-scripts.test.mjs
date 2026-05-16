import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  defaultManifestPath,
  parseChecksumFile,
  readJson,
  validateManifest,
} from "../os-release-lib.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(new URL("../../../..", import.meta.url).pathname);

test("beta manifest carries required beta dates, presale terms, and artifact classes", async () => {
  const manifest = await readJson(defaultManifestPath);
  const result = validateManifest(manifest);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(manifest.release.availableDate, "2026-05-16");
  assert.equal(manifest.commerce.usbKeyPresale.priceUsd, 49);
  assert.equal(manifest.commerce.usbKeyPresale.estimatedShipWindow.starts, "2026-10-01");
  assert.equal(manifest.commerce.usbKeyPresale.estimatedShipWindow.ends, "2026-10-31");
  assert.ok(manifest.artifacts.some((artifact) => artifact.kind === "raw-image"));
  assert.ok(manifest.artifacts.some((artifact) => artifact.kind === "vm-image"));
  assert.ok(manifest.artifacts.some((artifact) => artifact.kind === "android-image"));
});

test("publishable validation requires concrete checksums and sizes", async () => {
  const manifest = await readJson(defaultManifestPath);
  const result = validateManifest(manifest, { requirePublishableChecksums: true });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("sha256 is required")));
  assert.ok(result.errors.some((error) => error.includes("sizeBytes is required")));
});

test("checksum generation and verification round-trip local artifacts", async () => {
  const sourceManifest = await readJson(defaultManifestPath);
  const tmp = await mkdtemp(path.join(os.tmpdir(), "elizaos-release-"));
  const manifestPath = path.join(tmp, "manifest.json");
  const artifactRoot = path.join(tmp, "artifacts");
  await execFileAsync("mkdir", ["-p", artifactRoot]);

  const fixtureArtifacts = [
    sourceManifest.artifacts.find((artifact) => artifact.kind === "raw-image"),
    sourceManifest.artifacts.find((artifact) => artifact.kind === "vm-image"),
    sourceManifest.artifacts.find((artifact) => artifact.kind === "android-image"),
  ];

  const manifest = {
    ...sourceManifest,
    artifacts: fixtureArtifacts.map((artifact) => ({
      ...artifact,
      status: "candidate",
      sizeBytes: null,
      sha256: null,
      validation: {
        ...artifact.validation,
        evidence: [],
      },
    })),
    checksumPolicy: {
      ...sourceManifest.checksumPolicy,
      generatedFile: path.join(tmp, "SHA256SUMS"),
    },
  };

  for (const artifact of manifest.artifacts) {
    await writeFile(
      path.join(artifactRoot, artifact.filename),
      `fixture payload for ${artifact.id}\n`,
    );
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const checksumsPath = path.join(tmp, "SHA256SUMS");
  await execFileAsync(
    process.execPath,
    [
      "packages/os/scripts/generate-release-checksums.mjs",
      "--manifest",
      manifestPath,
      "--artifact-root",
      artifactRoot,
      "--output",
      checksumsPath,
      "--update-manifest",
    ],
    { cwd: repoRoot },
  );

  const checksumRecords = parseChecksumFile(await readFile(checksumsPath, "utf8"));
  assert.equal(checksumRecords.length, 3);

  const updated = await readJson(manifestPath);
  assert.ok(updated.artifacts.every((artifact) => /^[a-f0-9]{64}$/.test(artifact.sha256)));
  assert.ok(updated.artifacts.every((artifact) => Number.isInteger(artifact.sizeBytes)));

  await execFileAsync(
    process.execPath,
    [
      "packages/os/scripts/verify-release-checksums.mjs",
      "--manifest",
      manifestPath,
      "--artifact-root",
      artifactRoot,
      "--checksums",
      checksumsPath,
    ],
    { cwd: repoRoot },
  );
});
