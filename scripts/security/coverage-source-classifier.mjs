#!/usr/bin/env node
/** Emits changed modules that retain runtime code after Node strips TypeScript-only syntax. */

import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

/** Returns true only when type erasure leaves code that can execute at runtime. */
export function sourceRetainsRuntimeCode(source) {
  return (
    stripTypeScriptTypes(source, {
      mode: "transform",
      sourceMap: false,
    }).trim().length > 0
  );
}

/** Classifier failures retain the file as a coverage target. */
export function pathRetainsRuntimeCode(
  path,
  warn = (message) => process.stderr.write(message),
) {
  try {
    const source = readFileSync(path, "utf8");
    return sourceRetainsRuntimeCode(source);
  } catch (error) {
    // A classifier failure must widen enforcement, never hide the source.
    warn(
      `[coverage-source-classifier] treating unclassifiable module as executable: ${path} (${error instanceof Error ? error.message : String(error)})\n`,
    );
    return true;
  }
}

/** Writes executable paths and explains independently proven exclusions. */
export function classifyPaths(
  paths,
  writeOutput = (message) => process.stdout.write(message),
  writeError = (message) => process.stderr.write(message),
) {
  for (const path of paths) {
    if (pathRetainsRuntimeCode(path, writeError)) {
      writeOutput(`${path}\n`);
    } else {
      writeError(
        `[coverage-source-classifier] excluding type-only module: ${path}\n`,
      );
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  classifyPaths(readFileSync(0, "utf8").split("\n").filter(Boolean));
}
