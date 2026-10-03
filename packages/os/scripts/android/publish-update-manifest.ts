#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/** Publish only authenticated exact-target contracts; never infer hardware from filenames. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPolicy,
  readJson,
  requireThat,
  root,
  validateEnvelope,
  verifyFile,
} from "./release-contract.ts";

export function generateUpdateManifest({
  directory,
  version,
  channel,
  tag,
  repository,
  policy = loadPolicy(),
}) {
  requireThat(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository),
    "invalid repository",
  );
  requireThat(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(tag), "invalid tag");
  const names = fs.readdirSync(directory);
  const contracts = names.filter((n) => n.endsWith(".android-release.json"));
  requireThat(contracts.length > 0, "no signed Android release contracts");
  const artifacts = [],
    seenArchives = new Set(),
    seenTargets = new Set();
  for (const filename of contracts.sort()) {
    const envelope = readJson(path.join(directory, filename));
    const { release: r, subjectSha256 } = validateEnvelope(envelope, policy);
    requireThat(
      r.operation === "os-install",
      "lab experiments cannot be published as installable releases",
    );
    requireThat(
      r.version === version && r.channel === channel && r.tag === tag,
      "release/channel/tag mismatch",
    );
    requireThat(
      !seenArchives.has(r.archive.filename) && !seenTargets.has(r.target.id),
      "duplicate archive/target",
    );
    const archivePath = verifyFile(directory, r.archive);
    const inspected = spawnSync(
      "python3",
      [
        path.join(root, "scripts/android/verify-release-archive.py"),
        archivePath,
      ],
      {
        input: JSON.stringify(r),
        encoding: "utf8",
        timeout: 600000,
        maxBuffer: 1024 * 1024,
      },
    );
    requireThat(
      !inspected.error && inspected.status === 0,
      `archive content verification failed: ${inspected.stderr ?? inspected.error?.message}`,
    );
    verifyFile(directory, r.archive);
    seenArchives.add(r.archive.filename);
    seenTargets.add(r.target.id);
    artifacts.push({
      target: r.target.id,
      codename: r.target.codename,
      kind: r.target.kind,
      artifactType: r.artifactType,
      filename: r.archive.filename,
      downloadUrl: `https://github.com/${repository}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(r.archive.filename)}`,
      sha256: r.archive.sha256,
      sizeBytes: r.archive.sizeBytes,
      subjectSha256,
      contract: envelope,
      requiredUnlockedBootloader: r.target.kind === "physical",
    });
  }
  requireThat(
    names.filter((n) => n.endsWith(".zip")).every((n) => seenArchives.has(n)),
    "archive without authenticated contract",
  );
  // The embedded signed contracts are authoritative; consumers must verify
  // them with current local trust/revocation policy, not trust this index alone.
  return { schemaVersion: 2, version, channel, tag, artifacts };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [directory, version, channel, tag, repository, output] =
      process.argv.slice(2);
    requireThat(
      directory && output && process.argv.length === 8,
      "usage: publish-update-manifest DIRECTORY VERSION CHANNEL TAG OWNER/REPO OUTPUT",
    );
    fs.writeFileSync(
      output,
      `${JSON.stringify(generateUpdateManifest({ directory, version, channel, tag, repository }), null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
