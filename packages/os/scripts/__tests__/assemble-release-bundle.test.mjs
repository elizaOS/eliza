import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { validateManifest } from "../os-release-lib.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);
const sourceManifest = path.join(
  repoRoot,
  "release/v0.1.0-beta.1/manifest.json",
);

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "elizaos-bundle-"));
  const downloads = path.join(root, "downloads");
  const output = path.join(root, "output");
  const manifestOutput = path.join(output, "manifest.json");
  const manifest = JSON.parse(await readFile(sourceManifest, "utf8"));
  await mkdir(downloads);
  for (const artifact of manifest.artifacts) {
    const directory = path.join(downloads, artifact.source.artifact);
    await mkdir(directory, { recursive: true });
    const sourceName = artifact.source.pattern.replace("*", "source");
    const subject = path.join(directory, sourceName);
    await writeFile(subject, `payload for ${artifact.id}\n`);
    await execFileAsync(
      process.execPath,
      [
        "scripts/create-release-evidence.mjs",
        "--artifact-id",
        artifact.id,
        "--source-artifact",
        artifact.source.artifact,
        "--subject",
        subject,
        "--evidence",
        buildEvidence,
        "--output",
        path.join(directory, `${artifact.id}.release-evidence.json`),
        "--repository",
        "elizaOS/os",
        "--source-sha",
        "a".repeat(40),
        "--run-id",
        "12345",
        "--run-attempt",
        "2",
        "--workflow",
        "fixture.yml",
        "--job",
        "fixture",
      ],
      { cwd: repoRoot },
    );
  }
  return { downloads, manifest, manifestOutput, output, root };
}

const buildEvidence =
  "mkosi-release-build,qemu-uefi-usb,persistent-reboot,usb-expanded-readback,whole-disk-install,alongside-install,desktop-acceptance,hardware-qualification,ed25519-signature,image-release-verified,lintian,slsa-provenance,upstream-ed25519-artifact,package-test,browser-e2e,virtual-block-device,syft-sbom";

async function assemble(paths, extraArgs = []) {
  return execFileAsync(
    process.execPath,
    [
      "scripts/assemble-release-bundle.mjs",
      "--manifest",
      sourceManifest,
      "--artifact-root",
      paths.downloads,
      "--output",
      paths.output,
      "--manifest-output",
      paths.manifestOutput,
      "--repository",
      "elizaOS/os",
      "--tag",
      "v0.1.0-beta.1",
      "--available-date",
      "2026-08-18",
      "--source-sha",
      "a".repeat(40),
      "--run-id",
      "12345",
      "--run-attempt",
      "2",
      ...extraArgs,
    ],
    { cwd: repoRoot },
  );
}

test("release assembly binds every Actions artifact to one publishable file", async () => {
  const paths = await fixture();
  await assemble(paths);
  const assembled = JSON.parse(await readFile(paths.manifestOutput, "utf8"));
  const validation = validateManifest(assembled, {
    requirePublishableChecksums: true,
  });
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(assembled.release.status, "available");
  assert.equal(assembled.release.availableDate, "2026-08-18");
  for (const artifact of assembled.artifacts) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
    assert.ok(artifact.sizeBytes > 0);
    assert.equal(artifact.status, "published");
    assert.equal(
      artifact.downloadUrl,
      `https://github.com/elizaOS/os/releases/download/v0.1.0-beta.1/${artifact.filename}`,
    );
    assert.ok(await readFile(path.join(paths.output, artifact.filename)));
  }
});

test("signed assembly records every required desktop signature", async () => {
  const paths = await fixture();
  for (const artifact of paths.manifest.artifacts) {
    const recordPath = path.join(
      paths.downloads,
      artifact.source.artifact,
      `${artifact.id}.release-evidence.json`,
    );
    const record = JSON.parse(await readFile(recordPath, "utf8"));
    record.evidence.push("apple-notarization", "authenticode");
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  }
  await assemble(paths);
  const assembled = JSON.parse(await readFile(paths.manifestOutput, "utf8"));
  const validation = validateManifest(assembled, {
    requirePublishableChecksums: true,
    requireDistributionSignatures: true,
  });
  assert.equal(validation.ok, true, validation.errors.join("\n"));
});

test("release assembly rejects coordinator-supplied evidence names", async () => {
  const paths = await fixture();
  await assert.rejects(
    assemble(paths, ["--evidence", buildEvidence]),
    /--evidence is forbidden/,
  );
});

test("release assembly rejects missing producer evidence", async () => {
  const paths = await fixture();
  const artifact = paths.manifest.artifacts[0];
  await writeFile(
    path.join(
      paths.downloads,
      artifact.source.artifact,
      `${artifact.id}.release-evidence.json`,
    ),
    "{}\n",
  );
  await assert.rejects(
    assemble(paths),
    /requires exactly one producer evidence record/,
  );
});

test("release assembly rejects producer identity and subject mismatches", async () => {
  const paths = await fixture();
  const artifact = paths.manifest.artifacts[0];
  const recordPath = path.join(
    paths.downloads,
    artifact.source.artifact,
    `${artifact.id}.release-evidence.json`,
  );
  const record = JSON.parse(await readFile(recordPath, "utf8"));
  record.producer.sourceSha = "b".repeat(40);
  record.subject.sha256 = "0".repeat(64);
  await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  await assert.rejects(
    assemble(paths),
    /subject SHA-256 mismatch[\s\S]*producer source SHA mismatch/,
  );
});

test("release assembly rejects duplicate producer evidence", async () => {
  const paths = await fixture();
  const artifact = paths.manifest.artifacts[0];
  const directory = path.join(paths.downloads, artifact.source.artifact);
  const record = await readFile(
    path.join(directory, `${artifact.id}.release-evidence.json`),
  );
  await writeFile(
    path.join(directory, "duplicate.release-evidence.json"),
    record,
  );
  await assert.rejects(
    assemble(paths),
    /requires exactly one producer evidence record; found 2/,
  );
});

test("release assembly rejects ambiguous producer output", async () => {
  const paths = await fixture();
  const artifact = paths.manifest.artifacts[0];
  await writeFile(
    path.join(paths.downloads, artifact.source.artifact, "second.raw.zst"),
    "ambiguous\n",
  );
  await assert.rejects(
    assemble(paths),
    /requires exactly one \*\.raw\.zst.*found 2/,
  );
});
