#!/usr/bin/env node
/** Emits changed modules that retain runtime code after Node strips TypeScript-only syntax. */

import { readFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { fileURLToPath } from "node:url";

const bunTypeScriptTranspiler = globalThis.Bun
  ? new globalThis.Bun.Transpiler({ loader: "ts" })
  : undefined;

function eraseTypeScriptSyntax(source) {
  if (typeof nodeModule.stripTypeScriptTypes === "function") {
    return nodeModule.stripTypeScriptTypes(source, {
      mode: "transform",
      sourceMap: false,
    });
  }
  if (bunTypeScriptTranspiler) {
    return bunTypeScriptTranspiler.transformSync(source);
  }
  throw new Error("TypeScript syntax erasure is unavailable in this runtime");
}

/** V8 emits no line records for a module made entirely of re-export facades. */
function isPureReExportFacade(source) {
  const reExport =
    /export\s+(?:\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?|\{[^}]*\})\s+from\s+["'][^"']+["']\s*;?/gs;
  return source.trim().length > 0 && source.replace(reExport, "").trim() === "";
}

/** Returns true only when type erasure leaves coverable runtime statements. */
export function sourceRetainsRuntimeCode(source) {
  const runtimeSource = eraseTypeScriptSyntax(source).trim();
  return runtimeSource.length > 0 && !isPureReExportFacade(runtimeSource);
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

/** Writes coverable paths and explains independently proven exclusions. */
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
        `[coverage-source-classifier] excluding module without coverable runtime statements: ${path}\n`,
      );
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  classifyPaths(readFileSync(0, "utf8").split("\n").filter(Boolean));
}
