#!/usr/bin/env node
/** Emits changed modules that retain runtime code after Node strips TypeScript-only syntax. */

import { execFileSync } from "node:child_process";
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

function runtimeSource(source) {
  return eraseTypeScriptSyntax(source).trim();
}

// Node's strip mode blanks type-only syntax to whitespace while preserving
// every comment, which keeps comment anchors invariant to type-annotation
// edits. Bun ships no comment-preserving type stripper (Bun.Transpiler drops
// comments), so under Bun the raw source is the anchor basis: a type-length
// edit can then shift a comment anchor and conservatively retain the module,
// which only ever widens coverage enforcement. The gate itself runs on Node.
function stripTypeScriptSyntaxPreservingComments(source) {
  if (typeof nodeModule.stripTypeScriptTypes === "function") {
    return nodeModule.stripTypeScriptTypes(source, {
      mode: "strip",
      sourceMap: false,
    });
  }
  return source;
}

/**
 * Captures every comment-like delimiter with a whitespace-insensitive source
 * anchor. False positives inside literals only widen coverage enforcement;
 * importantly, tooling directives can never disappear from the proof.
 */
function commentSensitiveRecords(source) {
  const stripped = stripTypeScriptSyntaxPreservingComments(source);
  const commentLike = /\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;
  const records = [];
  let cursor = 0;
  let anchor = 0;
  for (const match of stripped.matchAll(commentLike)) {
    const index = match.index ?? 0;
    anchor += stripped.slice(cursor, index).replace(/\s/g, "").length;
    records.push([anchor, match[0]]);
    anchor += match[0].replace(/\s/g, "").length;
    cursor = index + match[0].length;
  }
  return records;
}

/** V8 emits no line records for a module made entirely of re-export facades. */
function isPureReExportFacade(source) {
  const reExport =
    /export\s+(?:\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?|\{[^}]*\})\s+from\s+["'][^"']+["']\s*;?/gs;
  return source.trim().length > 0 && source.replace(reExport, "").trim() === "";
}

/** Returns true only when type erasure leaves coverable runtime statements. */
export function sourceRetainsRuntimeCode(source) {
  const emittedSource = runtimeSource(source);
  return emittedSource.length > 0 && !isPureReExportFacade(emittedSource);
}

/** Returns true unless emitted JavaScript and comment-sensitive tokens match. */
export function sourceChangesRuntimeCode(baseSource, headSource) {
  // Type annotations can alter emitted decorator metadata under repository
  // tsconfigs even when Node's transform output is otherwise identical.
  if (
    baseSource !== headSource &&
    (baseSource.includes("@") || headSource.includes("@"))
  ) {
    return true;
  }
  const emittedHead = runtimeSource(headSource);
  if (emittedHead.length === 0 || isPureReExportFacade(emittedHead)) {
    return false;
  }
  if (runtimeSource(baseSource) !== emittedHead) return true;
  return (
    JSON.stringify(commentSensitiveRecords(baseSource)) !==
    JSON.stringify(commentSensitiveRecords(headSource))
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

/** Writes coverable paths and explains independently proven exclusions. */
export function classifyPaths(
  paths,
  writeOutput = (message) => process.stdout.write(message),
  writeError = (message) => process.stderr.write(message),
  { readBaseSource } = {},
) {
  for (const path of paths) {
    if (!pathRetainsRuntimeCode(path, writeError)) {
      writeError(
        `[coverage-source-classifier] excluding module without coverable runtime statements: ${path}\n`,
      );
      continue;
    }

    if (readBaseSource) {
      try {
        const baseSource = readBaseSource(path);
        if (baseSource !== undefined) {
          const headSource = readFileSync(path, "utf8");
          if (!sourceChangesRuntimeCode(baseSource, headSource)) {
            writeError(
              `[coverage-source-classifier] excluding runtime-equivalent source change: ${path}\n`,
            );
            continue;
          }
        }
      } catch (error) {
        // A failed comparison must retain the module just like a failed parse.
        writeError(
          `[coverage-source-classifier] treating unclassifiable source change as executable: ${path} (${error instanceof Error ? error.message : String(error)})\n`,
        );
      }
    }

    writeOutput(`${path}\n`);
  }
}

function parseBaseRef(args) {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--base" && args[1]) return args[1];
  throw new Error(
    "usage: coverage-source-classifier.mjs [--base <git-revision>]",
  );
}

function readSourceAtRevision(revision, path) {
  try {
    return execFileSync("git", ["cat-file", "blob", `${revision}:${path}`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // New and renamed paths have no blob at the merge base. Retaining them is
    // conservative, and also fail-widens unexpected Git lookup failures.
    return undefined;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const baseRef = parseBaseRef(process.argv.slice(2));
  classifyPaths(
    readFileSync(0, "utf8").split("\n").filter(Boolean),
    undefined,
    undefined,
    {
      readBaseSource: baseRef
        ? (path) => readSourceAtRevision(baseRef, path)
        : undefined,
    },
  );
}
