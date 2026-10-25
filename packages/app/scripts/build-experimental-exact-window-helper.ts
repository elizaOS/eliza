#!/usr/bin/env node
/** Builds the optional direct-only macOS exact-window helper and its provenance manifest. */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);
const appCoreDir = path.dirname(scriptDir);
const electrobunDir = path.join(appCoreDir, "platforms", "electrobun");
const sourceDir = path.join(
  electrobunDir,
  "direct-only",
  "computeruse-exact-window",
);
const outputDir = path.join(electrobunDir, "build");
const outputPath = path.join(outputDir, "computeruse-exact-window-helper");
const manifestPath = `${outputPath}.manifest.json`;
const sourcePaths = [
  path.join(sourceDir, "ExperimentalExactWindowProtocol.swift"),
  path.join(sourceDir, "ExperimentalExactWindowSPI.swift"),
  path.join(sourceDir, "main.swift"),
];

export function resolveExperimentalHelperBuildPlan({ buildVariant, platform }) {
  if (buildVariant !== "direct") {
    throw new Error(
      "Experimental exact-window helper may only be built for the direct distribution variant",
    );
  }
  if (platform !== "darwin") {
    throw new Error(
      "Experimental exact-window helper may only be built on macOS",
    );
  }
  return {
    sourcePaths,
    outputPath,
    manifestPath,
    compilerArguments: [
      "swiftc",
      "-O",
      "-framework",
      "ApplicationServices",
      "-framework",
      "AppKit",
      ...sourcePaths,
      "-o",
      outputPath,
    ],
  };
}

function parseArg(name) {
  const prefix = `--${name}=`;
  return process.argv
    .find((value) => value.startsWith(prefix))
    ?.slice(prefix.length);
}

function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function main() {
  const buildVariant = parseArg("build-variant") ?? "direct";
  const plan = resolveExperimentalHelperBuildPlan({
    buildVariant,
    platform: process.platform,
  });
  if (process.argv.includes("--plan")) {
    process.stdout.write(`${JSON.stringify(plan)}\n`);
    return;
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const result = spawnSync("xcrun", plan.compilerArguments, {
    cwd: appCoreDir,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `Experimental exact-window helper compilation failed with exit ${String(result.status)}`,
    );
  }
  fs.chmodSync(outputPath, 0o755);
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        schema: "elizaos.computeruse.experimental-exact-window/v1",
        distribution: "direct-only",
        defaultEnabled: false,
        route: "experimental_direct_exact_window",
        minimumMacOSMajor: 14,
        sourceRevision:
          "iFurySt/open-codex-computer-use@ead48da2032c69b892c89fd39d38fa587b4d6fbf",
        license: "MIT",
        sha256: sha256(outputPath),
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  main();
}
