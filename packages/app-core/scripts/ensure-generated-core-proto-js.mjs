#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const generatedDirCandidates = [
  path.join(
    repoRoot,
    "packages",
    "core",
    "src",
    "types",
    "generated",
    "eliza",
    "v1",
  ),
  path.join(
    repoRoot,
    "eliza",
    "packages",
    "core",
    "src",
    "types",
    "generated",
    "eliza",
    "v1",
  ),
  path.join(
    repoRoot,
    "packages",
    "typescript",
    "src",
    "types",
    "generated",
    "eliza",
    "v1",
  ),
  path.join(
    repoRoot,
    "eliza",
    "packages",
    "typescript",
    "src",
    "types",
    "generated",
    "eliza",
    "v1",
  ),
];
const generatedDir =
  generatedDirCandidates.find((candidate) => fs.existsSync(candidate)) ??
  generatedDirCandidates[0];

if (!fs.existsSync(generatedDir)) {
  // Nothing in the repo currently generates these proto files (no .proto
  // sources, no buf config), and no source file imports them. The Docker
  // CI build invokes this script unconditionally, so missing-dir was
  // failing the whole build for a directory that's a no-op. Skip cleanly
  // when the dir doesn't exist; throw only on the genuine error case
  // where the dir exists but has no `_pb.ts` files (which would mean
  // someone ran the proto generator partially).
  console.warn(
    `[ensure-generated-core-proto-js] Skipped: ${path.relative(
      repoRoot,
      generatedDir,
    )} not present (no proto sources in tree).`,
  );
  process.exit(0);
}

const files = fs
  .readdirSync(generatedDir)
  .filter((name) => name.endsWith("_pb.ts"))
  .sort();

if (files.length === 0) {
  throw new Error(
    `No generated proto TypeScript files found in ${path.relative(repoRoot, generatedDir)}`,
  );
}

let written = 0;
for (const file of files) {
  const inputPath = path.join(generatedDir, file);
  const outputPath = inputPath.replace(/\.ts$/, ".js");
  const inputStat = fs.statSync(inputPath);
  const outputStat = fs.existsSync(outputPath) ? fs.statSync(outputPath) : null;

  if (outputStat && outputStat.mtimeMs >= inputStat.mtimeMs) {
    continue;
  }

  const source = fs.readFileSync(inputPath, "utf8");
  const result = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      sourceMap: false,
      inlineSources: false,
    },
    fileName: inputPath,
    reportDiagnostics: true,
  });

  const diagnostic = result.diagnostics?.find(
    (item) => item.category === ts.DiagnosticCategory.Error,
  );
  if (diagnostic) {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );
    throw new Error(`Failed to transpile ${file}: ${message}`);
  }

  fs.writeFileSync(outputPath, result.outputText);
  written += 1;
}

console.log(
  `[generated-proto] wrote ${written} runtime file${written === 1 ? "" : "s"} in ${path.relative(repoRoot, generatedDir)}`,
);
