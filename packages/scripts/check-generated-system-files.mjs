#!/usr/bin/env node
/**
 * Verifies generated compatibility copies of repository meta-system files.
 *
 * Standalone plugins and CLI templates retain local config/workflow bytes, but
 * their source is declared here and drift is rejected. Use `--write` only when
 * intentionally regenerating every member of a declared group.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectNativeCapacitorScaffoldDrift } from "./native-capacitor-scaffold.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const manifest = JSON.parse(
  readFileSync(
    path.join(
      REPO_ROOT,
      "packages/scripts/generated-system-files.manifest.json",
    ),
    "utf8",
  ),
);
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.groups)) {
  throw new Error("Invalid generated-system-files manifest schema");
}
export const GENERATED_SYSTEM_FILE_GROUPS = manifest.groups;
const APPROVED_BESPOKE_NPM_WORKFLOWS = new Set(
  Object.keys(manifest.approvedBespokeNpmWorkflows ?? {}),
);

function walk(directory, output = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, output);
    else output.push(absolute);
  }
  return output;
}

export function assertGeneratedGroupContents(
  group,
  read = (relative) => readFileSync(path.join(REPO_ROOT, relative)),
) {
  const source = read(group.source);
  for (const generated of group.generated) {
    if (!source.equals(read(generated))) {
      throw new Error(
        `${generated} drifted from generated source ${group.source}`,
      );
    }
  }
}

export function checkGeneratedSystemFiles(
  collectNativeDrift = collectNativeCapacitorScaffoldDrift,
) {
  for (const group of GENERATED_SYSTEM_FILE_GROUPS)
    assertGeneratedGroupContents(group);
  const generatedWorkflows = new Set(
    GENERATED_SYSTEM_FILE_GROUPS.find(
      ({ id }) => id === "standalone-plugin-npm-deploy",
    ).generated,
  );
  const nestedWorkflows = walk(path.join(REPO_ROOT, "plugins"))
    .map((absolute) =>
      path.relative(REPO_ROOT, absolute).split(path.sep).join("/"),
    )
    .filter((relative) =>
      relative.endsWith("/.github/workflows/npm-deploy.yml"),
    );
  for (const workflow of nestedWorkflows) {
    if (
      !generatedWorkflows.has(workflow) &&
      !APPROVED_BESPOKE_NPM_WORKFLOWS.has(workflow)
    ) {
      throw new Error(`Unclassified nested npm deploy workflow: ${workflow}`);
    }
  }
  const nativeDrift = collectNativeDrift(REPO_ROOT);
  if (nativeDrift.length > 0) {
    throw new Error(
      `Native Capacitor scaffold drifted:\n${nativeDrift
        .map((file) => `- ${file}`)
        .join("\n")}`,
    );
  }
}

export function writeGeneratedSystemFiles() {
  for (const group of GENERATED_SYSTEM_FILE_GROUPS) {
    const source = readFileSync(path.join(REPO_ROOT, group.source));
    for (const generated of group.generated) {
      writeFileSync(path.join(REPO_ROOT, generated), source);
    }
  }
}

if (process.argv.includes("--write")) writeGeneratedSystemFiles();
else checkGeneratedSystemFiles();
