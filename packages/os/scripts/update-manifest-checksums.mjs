#!/usr/bin/env node
// Updates a release manifest JSON with sha256 checksums and file sizes after artifacts are built.
// Usage: node update-manifest-checksums.mjs --manifest <path> --artifacts-dir <dir>

import { createReadStream, readFileSync, writeFileSync, statSync, existsSync } from "fs";
import { createHash } from "crypto";
import { resolve, join } from "path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      args[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest || !args["artifacts-dir"]) {
    console.error(
      "Usage: node update-manifest-checksums.mjs --manifest <path> --artifacts-dir <dir>"
    );
    process.exit(1);
  }

  const manifestPath = resolve(args.manifest);
  const artifactsDir = resolve(args["artifacts-dir"]);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const artifact of manifest.artifacts ?? []) {
    if (artifact.sha256 !== null && artifact.sha256 !== undefined) {
      skipped++;
      continue;
    }
    const filePath = join(artifactsDir, artifact.filename);
    if (!existsSync(filePath)) {
      console.warn(`Missing: ${artifact.filename} — skipping`);
      missing++;
      continue;
    }
    try {
      const sha256 = await sha256File(filePath);
      const { size } = statSync(filePath);
      artifact.sha256 = sha256;
      artifact.sizeBytes = size;
      if (artifact.status === "candidate") artifact.status = "available";
      artifact.validation ??= { evidence: [] };
      if (!artifact.validation.evidence.includes("sha256-generated")) {
        artifact.validation.evidence.push("sha256-generated");
      }
      console.log(`Updated: ${artifact.filename}  sha256=${sha256}`);
      updated++;
    } catch (err) {
      console.warn(`Error processing ${artifact.filename}: ${err.message}`);
      missing++;
    }
  }

  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  console.log(
    `\nDone: ${updated} updated, ${skipped} already set, ${missing} missing/errored`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
