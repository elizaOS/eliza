#!/usr/bin/env node

import { existsSync } from "node:fs";

// Log that we're starting
console.log("Running pre-commit hook...");

const generatedAppPlatformPrefixes = [
  "packages/app/android/",
  "packages/app/ios/",
  "packages/app/electrobun/",
];

function readStagedFiles() {
  console.log("Checking for staged files...");
  const proc = Bun.spawnSync(["git", "diff", "--staged", "--name-only"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error("Failed to get staged files");
  }

  return new TextDecoder()
    .decode(proc.stdout)
    .trim()
    .split("\n")
    .filter(Boolean);
}

function readNewOrModifiedStagedFiles() {
  const proc = Bun.spawnSync(
    ["git", "diff", "--staged", "--name-only", "--diff-filter=ACMR"],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  if (proc.exitCode !== 0) {
    throw new Error("Failed to get new or modified staged files");
  }

  return new TextDecoder()
    .decode(proc.stdout)
    .trim()
    .split("\n")
    .filter(Boolean);
}

function assertNoGeneratedAppPlatformsStaged() {
  const blockedFiles = readNewOrModifiedStagedFiles().filter((file) =>
    generatedAppPlatformPrefixes.some((prefix) => file.startsWith(prefix)),
  );

  if (blockedFiles.length === 0) return;

  const formattedFiles = blockedFiles.map((file) => `  - ${file}`).join("\n");
  throw new Error(
    [
      "Generated app platform files must not be committed.",
      "Canonical native templates live under packages/app-core/platforms and packages/app/* platform shells are materialized during builds.",
      "Unstage these files and rely on the ignored generated output instead:",
      formattedFiles,
    ].join("\n"),
  );
}

try {
  // Get all staged files using git diff --staged instead
  assertNoGeneratedAppPlatformsStaged();
  const stagedFiles = readStagedFiles();

  console.log(`Found ${stagedFiles.length} staged files.`);

  if (stagedFiles.length === 0) {
    console.log("No staged files to lint");
    process.exit(0);
  }

  // Filter for files we want to process and check that they exist
  const filesToLint = stagedFiles.filter((file) => {
    const extensions = [".js", ".jsx", ".ts", ".tsx", ".json", ".css", ".md"];
    // Only include files that have valid extensions AND still exist (not deleted)
    return extensions.some((ext) => file.endsWith(ext)) && existsSync(file);
  });

  console.log(
    `Found ${filesToLint.length} files to format: ${filesToLint.join(", ")}`,
  );

  if (filesToLint.length === 0) {
    console.log("No matching files to lint");
    process.exit(0);
  }

  // Run Biome on the files
  console.log("Running Biome on staged files...");
  const biomeProc = Bun.spawnSync(
    ["bunx", "@biomejs/biome", "check", "--write", ...filesToLint],
    {
      stdout: "inherit",
      stderr: "inherit",
    },
  );

  if (biomeProc.exitCode !== 0) {
    throw new Error("Biome formatting/linting failed");
  }

  // Add the formatted files back to staging
  const gitAddProc = Bun.spawnSync(["git", "add", ...filesToLint], {
    stdout: "inherit",
    stderr: "inherit",
  });

  if (gitAddProc.exitCode !== 0) {
    throw new Error("Failed to add files to git");
  }

  console.log("Pre-commit linting completed successfully");
  process.exit(0);
} catch (error) {
  console.error("Error during pre-commit linting:", error.message);
  process.exit(1);
}
