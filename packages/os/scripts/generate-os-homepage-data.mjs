#!/usr/bin/env node
// Generates the public OS homepage download manifest from a release manifest.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "./os-release-lib.mjs";

const args = parseArgs(process.argv.slice(2));
if (!args.manifest || !args.output) {
  console.error(
    "Usage: node generate-os-homepage-data.mjs --manifest PATH --output PATH [--checksums-url URL]",
  );
  process.exit(1);
}

const manifestPath = path.resolve(args.manifest);
const outputPath = path.resolve(args.output);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const release = manifest?.release;

if (
  !release ||
  typeof release.channel !== "string" ||
  typeof release.availableDate !== "string" ||
  !/^\d{4}-\d{2}-\d{2}$/.test(release.availableDate) ||
  !Array.isArray(manifest.artifacts)
) {
  throw new Error("release manifest is missing homepage release metadata");
}

const homepageKinds = new Set([
  "raw-image",
  "package",
  "setup-installer",
  "usb-installer",
]);

function platformLabel(platform) {
  if (platform === "macos") return "macOS";
  if (platform === "windows") return "Windows";
  return "Linux";
}

function artifactLabel(artifact) {
  const platform = platformLabel(artifact.target.platform);
  switch (artifact.kind) {
    case "raw-image":
      return `elizaOS persistent image for ${artifact.target.architecture}`;
    case "package":
      return `elizaOS Debian package for ${artifact.target.architecture}`;
    case "setup-installer":
      return `elizaOS Setup for ${platform}`;
    case "usb-installer":
      return `elizaOS USB Installer for ${platform}`;
    default:
      throw new Error(`unsupported homepage artifact kind: ${artifact.kind}`);
  }
}

const artifacts = manifest.artifacts
  .filter((artifact) => homepageKinds.has(artifact?.kind))
  .map((artifact) => {
    if (
      typeof artifact.id !== "string" ||
      typeof artifact.target?.platform !== "string" ||
      typeof artifact.target?.architecture !== "string" ||
      !(artifact.downloadUrl === null || typeof artifact.downloadUrl === "string")
    ) {
      throw new Error("release manifest contains an invalid homepage artifact");
    }
    return {
      id: artifact.id,
      label: artifactLabel(artifact),
      kind: artifact.kind,
      platform: artifact.target.platform,
      architecture: artifact.target.architecture,
      url: artifact.downloadUrl,
      checksumUrl: args["checksums-url"] ?? null,
    };
  });

if (artifacts.length === 0) {
  throw new Error("release manifest contains no public download artifacts");
}

const output = {
  schemaVersion: 1,
  product: "elizaOS",
  channel: release.channel,
  availableFrom: release.availableDate,
  artifacts,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Generated ${artifacts.length} OS homepage artifacts → ${outputPath}`);
