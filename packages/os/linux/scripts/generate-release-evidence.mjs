#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const distroRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
let outDir = path.join(distroRoot, "out/release-evidence");
let artifact = "";

for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (arg === "--out") {
    outDir = path.resolve(process.argv[index + 1]);
    index += 1;
  } else if (arg.startsWith("--out=")) {
    outDir = path.resolve(arg.slice("--out=".length));
  } else if (arg === "--artifact") {
    artifact = path.resolve(process.argv[index + 1]);
    index += 1;
  } else if (arg.startsWith("--artifact=")) {
    artifact = path.resolve(arg.slice("--artifact=".length));
  }
}

function git(args, fallback = null) {
  try {
    return execFileSync("git", args, {
      cwd: distroRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return fallback;
  }
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function listPackageInventory() {
  const appManifestPath = path.join(
    distroRoot,
    "tails/config/chroot_local-includes/usr/share/elizaos/elizaos-app/Resources/app/elizaos-live-overlay-manifest.json",
  );
  const appManifest = readJsonIfExists(appManifestPath);
  return {
    appOverlayManifest: appManifest
      ? {
          path: path.relative(distroRoot, appManifestPath),
          sha256: sha256(appManifestPath),
          packageJsonCount: appManifest.packages?.packageJsonCount ?? null,
          generatedPackageCount:
            appManifest.generated?.packages?.length ?? null,
        }
      : null,
  };
}

fs.mkdirSync(outDir, { recursive: true });

const commit = git(["rev-parse", "HEAD"]);
const dirty = git(["status", "--short"], "")?.length > 0;
const generatedAt = new Date().toISOString();
const artifactEvidence =
  artifact && fs.existsSync(artifact)
    ? {
        path: artifact,
        size: fs.statSync(artifact).size,
        sha256: sha256(artifact),
      }
    : null;

const sbomLite = {
  schemaVersion: 1,
  kind: "elizaos.sbomLite",
  generatedAt,
  distro: "elizaos-linux",
  source: {
    gitCommit: commit,
    gitDirty: dirty,
  },
  packages: listPackageInventory(),
  limitations: [
    "This is a lightweight release-evidence index, not a full SPDX/CycloneDX SBOM.",
    "Stable releases still require generated OS package SBOM and app/runtime SBOM artifacts.",
  ],
};

const provenance = {
  schemaVersion: 1,
  kind: "elizaos.releaseProvenance",
  generatedAt,
  distroRoot,
  source: {
    gitCommit: commit,
    gitBranch: git(["branch", "--show-current"]),
    gitDirty: dirty,
  },
  artifact: artifactEvidence,
  builder: {
    host: process.env.HOSTNAME ?? null,
    user: process.env.USER ?? null,
    node: process.version,
  },
  releaseGates: {
    staticSmoke: "required",
    securitySmoke: "required",
    strictSecuritySmoke: "required for release candidates",
    qemuBoot: "required before demo handoff",
    realUsbBoot: "required before public release",
  },
};

const sbomPath = path.join(outDir, "sbom-lite.json");
const provenancePath = path.join(outDir, "provenance.json");
fs.writeFileSync(sbomPath, `${JSON.stringify(sbomLite, null, 2)}\n`);
fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);

console.log(`wrote ${path.relative(distroRoot, sbomPath)}`);
console.log(`wrote ${path.relative(distroRoot, provenancePath)}`);
