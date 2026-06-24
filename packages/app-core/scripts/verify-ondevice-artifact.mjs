#!/usr/bin/env node
/**
 * CLI: verify a staged on-device artifact contains the freshly built renderer +
 * required companion files (agent bundle, native libs). A post-build CI gate for
 * issue #9309.
 *
 * Usage:
 *   node verify-ondevice-artifact.mjs \
 *     --renderer-dir packages/app/ios/App/App/public \
 *     --fresh-dist packages/app/dist \
 *     --require agent/agent-bundle.js \
 *     --label ios
 *
 *   # presets resolve the standard paths for a platform:
 *   node verify-ondevice-artifact.mjs --platform ios [--local]
 *   node verify-ondevice-artifact.mjs --platform desktop
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyStagedArtifact } from "./lib/verify-ondevice-artifact.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..", "..");

function arg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}
function repeatedArg(name) {
  const out = [];
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) {
      out.push(process.argv[i + 1]);
    }
  }
  return out;
}

function presetFor(platform, { local }) {
  const appDist = path.join(repoRoot, "packages", "app", "dist");
  if (platform === "ios") {
    return {
      rendererDir: path.join(
        repoRoot,
        "packages",
        "app",
        "ios",
        "App",
        "App",
        "public",
      ),
      freshDistDir: appDist,
      requiredFiles: local ? ["agent/agent-bundle.js"] : [],
      label: "ios",
    };
  }
  if (platform === "android") {
    return {
      rendererDir: path.join(
        repoRoot,
        "packages",
        "app-core",
        "platforms",
        "android",
        "app",
        "src",
        "main",
        "assets",
        "public",
      ),
      freshDistDir: appDist,
      requiredFiles: [],
      label: "android",
    };
  }
  if (platform === "desktop") {
    return {
      rendererDir: appDist,
      freshDistDir: appDist,
      requiredFiles: [],
      label: "desktop",
    };
  }
  throw new Error(`unknown --platform ${platform}`);
}

const platform = arg("platform");
const config = platform
  ? presetFor(platform, { local: flag("local") })
  : {
      rendererDir: path.resolve(arg("renderer-dir") ?? "."),
      freshDistDir: arg("fresh-dist") ? path.resolve(arg("fresh-dist")) : null,
      requiredFiles: repeatedArg("require"),
      label: arg("label") ?? "artifact",
    };

const result = verifyStagedArtifact(config);
if (!result.ok) {
  console.error(`[verify-ondevice-artifact] FAIL (${config.label}):`);
  for (const problem of result.problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(
  `[verify-ondevice-artifact] OK (${config.label}): renderer buildId=${
    result.manifest ? String(result.manifest.buildId).slice(0, 12) : "?"
  }, ${config.requiredFiles.length} required file(s) present.`,
);
