#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);
const generatedDir = path.join(
  repoRoot,
  "eliza",
  "packages",
  "typescript",
  "src",
  "types",
  "generated",
  "eliza",
  "v1",
);

if (!fs.existsSync(generatedDir)) {
  throw new Error(
    `Missing generated proto source directory: ${path.relative(repoRoot, generatedDir)}`,
  );
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
  const outputStat = fs.existsSync(outputPath)
    ? fs.statSync(outputPath)
    : null;

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
