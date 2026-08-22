#!/usr/bin/env node

/**
 * Strict helpers for the provisioning host's systemd EnvironmentFile.
 *
 * Setting values are accepted only on stdin or through mode-0600 plan files;
 * the CLI argv and bounded diagnostics contain names and paths, never values.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_VALUE_BYTES = 128 * 1024;
const MAX_ENVIRONMENT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RECONCILE_ATTEMPTS = 4;
const NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
const EXISTING_ASSIGNMENT_PATTERN =
  /^[ \t\r]*([A-Za-z_][A-Za-z0-9_]{0,127})[ \t\r]*=([\s\S]*)$/;

function assertName(name) {
  if (!NAME_PATTERN.test(name)) {
    throw new Error("SYSTEMD_ENVIRONMENT_NAME_INVALID");
  }
}

export function serializeSystemdEnvironmentLine(name, value) {
  assertName(name);
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error("SYSTEMD_ENVIRONMENT_VALUE_INVALID");
  }
  const quoted = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `${name}="${quoted}"\n`;
}

/** Decode the deliberately small, single-line subset emitted above. */
export function decodeSystemdEnvironmentValue(rawValue) {
  if (typeof rawValue !== "string" || /[\0\r\n]/.test(rawValue)) {
    throw new Error("SYSTEMD_ENVIRONMENT_VALUE_INVALID");
  }

  const input = rawValue.trim();
  if (input === "") return "";

  const quote = input[0];
  if (quote === '"' || quote === "'") {
    let decoded = "";
    let index = 1;
    for (; index < input.length; index += 1) {
      const character = input[index];
      if (character === quote) {
        if (input.slice(index + 1).trim() !== "") {
          throw new Error("SYSTEMD_ENVIRONMENT_VALUE_INVALID");
        }
        return decoded;
      }
      if (quote === "'" || character !== "\\") {
        decoded += character;
        continue;
      }

      index += 1;
      if (index >= input.length) {
        throw new Error("SYSTEMD_ENVIRONMENT_VALUE_INVALID");
      }
      const escaped = input[index];
      // systemd preserves a backslash before non-special characters inside
      // double quotes. The serializer only emits the two supported escapes.
      decoded += escaped === "\\" || escaped === '"' ? escaped : `\\${escaped}`;
    }
    throw new Error("SYSTEMD_ENVIRONMENT_VALUE_INVALID");
  }

  let decoded = "";
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    index += 1;
    if (index >= input.length) {
      throw new Error("SYSTEMD_ENVIRONMENT_VALUE_INVALID");
    }
    decoded += input[index];
  }
  return decoded;
}

function parseAssignmentLine(line) {
  const match = EXISTING_ASSIGNMENT_PATTERN.exec(line);
  if (!match) return null;
  const name = match[1];
  const rawValue = match[2];
  if (!name || rawValue === undefined) return null;
  return {
    name,
    value: decodeSystemdEnvironmentValue(rawValue),
  };
}

function parsePreservedEnvironmentLine(line) {
  if (/^[ \t\r]*(?:$|[#;])/.test(line)) return null;
  const assignment = parseAssignmentLine(line);
  if (!assignment) {
    throw new Error("SYSTEMD_ENVIRONMENT_FILE_INVALID");
  }
  return assignment;
}

export function lookupSystemdEnvironmentValue(contents, name) {
  assertName(name);
  if (
    typeof contents !== "string" ||
    Buffer.byteLength(contents, "utf8") > MAX_ENVIRONMENT_FILE_BYTES ||
    contents.includes("\0")
  ) {
    throw new Error("SYSTEMD_ENVIRONMENT_FILE_INVALID");
  }

  const matches = [];
  for (const line of contents.split(/\r?\n/)) {
    const assignment = parsePreservedEnvironmentLine(line);
    if (!assignment || assignment.name !== name) continue;
    matches.push(assignment.value);
  }
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0
        ? "SYSTEMD_ENVIRONMENT_NAME_MISSING"
        : "SYSTEMD_ENVIRONMENT_NAME_DUPLICATE",
    );
  }
  return matches[0];
}

function parseReplacementNames(contents) {
  const names = new Set();
  for (const line of contents.split(/\r?\n/)) {
    if (line === "") continue;
    assertName(line);
    if (names.has(line)) {
      throw new Error("SYSTEMD_ENVIRONMENT_PLAN_INVALID");
    }
    names.add(line);
  }
  if (names.size === 0) {
    throw new Error("SYSTEMD_ENVIRONMENT_PLAN_INVALID");
  }
  return names;
}

function parsePlannedAssignments(contents, replacementNames) {
  const assignments = [];
  const assignedNames = new Set();
  for (const line of contents.split(/\r?\n/)) {
    if (line === "") continue;
    const assignment = parseAssignmentLine(line);
    if (
      !assignment ||
      !replacementNames.has(assignment.name) ||
      assignedNames.has(assignment.name)
    ) {
      throw new Error("SYSTEMD_ENVIRONMENT_PLAN_INVALID");
    }
    assignedNames.add(assignment.name);
    // Canonicalize again so a hand-crafted plan cannot smuggle unsupported
    // EnvironmentFile syntax past validation.
    assignments.push(
      serializeSystemdEnvironmentLine(assignment.name, assignment.value),
    );
  }
  return assignments.join("");
}

function mergeEnvironmentFile(current, replacementNames, assignments) {
  const kept = [];
  for (const line of current.split(/\r?\n/)) {
    if (line === "" && kept.length === 0) continue;
    const assignment = parsePreservedEnvironmentLine(line);
    if (assignment && replacementNames.has(assignment.name)) continue;
    kept.push(line);
  }
  while (kept.at(-1) === "") kept.pop();
  const prefix = kept.length > 0 ? `${kept.join("\n")}\n` : "";
  return `${prefix}${assignments}`;
}

function isMissingFileError(error) {
  return Boolean(
    error &&
      typeof error === "object" &&
      Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT",
  );
}

function snapshotIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function decodeUtf8File(bytes, invalidCode) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // error-policy:J3 EnvironmentFile and plan bytes are untrusted; invalid
    // UTF-8 is a closed validation failure, never replacement characters.
    throw new Error(invalidCode);
  }
}

/** Read a stable content + inode snapshot even when an uncooperative writer is active. */
function readEnvironmentFileSnapshot(targetPath) {
  for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
    let before;
    try {
      before = lstatSync(targetPath, { bigint: true });
    } catch (error) {
      // error-policy:J3 ENOENT is an explicit absent snapshot; every other
      // filesystem failure remains fatal.
      if (!isMissingFileError(error)) throw error;
      try {
        lstatSync(targetPath);
      } catch (confirmationError) {
        // error-policy:J3 confirm the untrusted filesystem state before
        // classifying a missing target as a stable empty snapshot.
        if (isMissingFileError(confirmationError)) {
          return Object.freeze({
            exists: false,
            contents: "",
            identity: "absent",
          });
        }
      }
      continue;
    }
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error("SYSTEMD_ENVIRONMENT_TARGET_INVALID");
    }
    if (before.size > BigInt(MAX_ENVIRONMENT_FILE_BYTES)) {
      throw new Error("SYSTEMD_ENVIRONMENT_FILE_INVALID");
    }

    let contents;
    let after;
    try {
      contents = decodeUtf8File(
        readFileSync(targetPath),
        "SYSTEMD_ENVIRONMENT_FILE_INVALID",
      );
      after = lstatSync(targetPath, { bigint: true });
    } catch (error) {
      // error-policy:J3 disappearance during the read is an invalidated
      // snapshot that must be retried; unrelated failures remain fatal.
      if (isMissingFileError(error)) continue;
      throw error;
    }
    if (
      snapshotIdentity(before) !== snapshotIdentity(after) ||
      Buffer.byteLength(contents, "utf8") !== Number(after.size)
    ) {
      continue;
    }
    if (contents.includes("\0")) {
      throw new Error("SYSTEMD_ENVIRONMENT_FILE_INVALID");
    }
    return Object.freeze({
      exists: true,
      contents,
      identity: `${snapshotIdentity(after)}:${createHash("sha256").update(contents).digest("hex")}`,
    });
  }
  throw new Error("SYSTEMD_ENVIRONMENT_TARGET_CHANGED");
}

function sameEnvironmentFileSnapshot(targetPath, expected) {
  try {
    const actual = readEnvironmentFileSnapshot(targetPath);
    return (
      actual.exists === expected.exists && actual.identity === expected.identity
    );
  } catch (error) {
    // error-policy:J3 an unstable target is an explicit retry signal, never a
    // substitute snapshot; unrelated failures remain fatal.
    if (
      error instanceof Error &&
      error.message === "SYSTEMD_ENVIRONMENT_TARGET_CHANGED"
    ) {
      return false;
    }
    throw error;
  }
}

/**
 * Replace the target only after the complete candidate is validated, written,
 * chmod/chowned, and fsynced. The caller holds flock for the whole operation.
 */
export function reconcileSystemdEnvironmentFile({
  targetPath,
  replacementNamesPath,
  assignmentsPath,
  ownerUid = process.getuid?.() ?? 0,
  ownerGid = process.getgid?.() ?? 0,
  preserveUnplanned = true,
  beforeRename,
}) {
  const namesContents = decodeUtf8File(
    readFileSync(replacementNamesPath),
    "SYSTEMD_ENVIRONMENT_PLAN_INVALID",
  );
  const assignmentsContents = decodeUtf8File(
    readFileSync(assignmentsPath),
    "SYSTEMD_ENVIRONMENT_PLAN_INVALID",
  );
  const replacementNames = parseReplacementNames(namesContents);
  const assignments = parsePlannedAssignments(
    assignmentsContents,
    replacementNames,
  );

  const parent = path.dirname(targetPath);
  mkdirSync(parent, { recursive: true, mode: 0o755 });
  for (let attempt = 0; attempt < MAX_RECONCILE_ATTEMPTS; attempt += 1) {
    const snapshot = readEnvironmentFileSnapshot(targetPath);
    const candidateContents = preserveUnplanned
      ? mergeEnvironmentFile(snapshot.contents, replacementNames, assignments)
      : assignments;
    if (
      Buffer.byteLength(candidateContents, "utf8") > MAX_ENVIRONMENT_FILE_BYTES
    ) {
      throw new Error("SYSTEMD_ENVIRONMENT_FILE_INVALID");
    }

    const temporaryDirectory = mkdtempSync(
      path.join(parent, `.${path.basename(targetPath)}.reconcile-`),
    );
    const candidatePath = path.join(temporaryDirectory, "candidate");
    let candidateExists = false;
    try {
      const descriptor = openSync(candidatePath, "wx", 0o600);
      candidateExists = true;
      try {
        writeFileSync(descriptor, candidateContents, "utf8");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      chmodSync(candidatePath, 0o600);
      chownSync(candidatePath, ownerUid, ownerGid);
      beforeRename?.(candidatePath, attempt);
      if (!sameEnvironmentFileSnapshot(targetPath, snapshot)) {
        continue;
      }
      renameSync(candidatePath, targetPath);
      candidateExists = false;

      const parentDescriptor = openSync(parent, "r");
      try {
        fsyncSync(parentDescriptor);
      } finally {
        closeSync(parentDescriptor);
      }
      return;
    } finally {
      if (candidateExists) {
        try {
          unlinkSync(candidatePath);
        } catch {
          // error-policy:J6 best-effort cleanup only; the target was never replaced.
        }
      }
      try {
        rmdirSync(temporaryDirectory);
      } catch {
        // error-policy:J6 a killed process can leave a root-owned hidden
        // candidate for operators; it never changes the active EnvironmentFile.
      }
    }
  }
  throw new Error("SYSTEMD_ENVIRONMENT_TARGET_CHANGED");
}

async function readStdinBounded(maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maximumBytes) {
      throw new Error("SYSTEMD_ENVIRONMENT_VALUE_INVALID");
    }
    chunks.push(buffer);
  }
  return decodeUtf8File(
    Buffer.concat(chunks),
    "SYSTEMD_ENVIRONMENT_VALUE_INVALID",
  );
}

const SAFE_ERROR_CODES = new Set([
  "SYSTEMD_ENVIRONMENT_COMMAND_INVALID",
  "SYSTEMD_ENVIRONMENT_FILE_INVALID",
  "SYSTEMD_ENVIRONMENT_NAME_DUPLICATE",
  "SYSTEMD_ENVIRONMENT_NAME_INVALID",
  "SYSTEMD_ENVIRONMENT_NAME_MISSING",
  "SYSTEMD_ENVIRONMENT_PLAN_INVALID",
  "SYSTEMD_ENVIRONMENT_TARGET_CHANGED",
  "SYSTEMD_ENVIRONMENT_TARGET_INVALID",
  "SYSTEMD_ENVIRONMENT_VALUE_EMPTY",
  "SYSTEMD_ENVIRONMENT_VALUE_INVALID",
  "SYSTEMD_ENVIRONMENT_VALUE_MISMATCH",
]);

function safeErrorCode(error) {
  try {
    const descriptor =
      error && (typeof error === "object" || typeof error === "function")
        ? Object.getOwnPropertyDescriptor(error, "message")
        : undefined;
    const code = descriptor && "value" in descriptor ? descriptor.value : "";
    return typeof code === "string" && SAFE_ERROR_CODES.has(code)
      ? code
      : "SYSTEMD_ENVIRONMENT_OPERATION_FAILED";
  } catch {
    // error-policy:J1 hostile thrown values collapse to one closed code without
    // invoking getters or reflecting provider-controlled text.
    return "SYSTEMD_ENVIRONMENT_OPERATION_FAILED";
  }
}

async function main() {
  const command = process.argv[2] ?? "";
  try {
    if (command === "serialize") {
      const value = await readStdinBounded(MAX_VALUE_BYTES);
      process.stdout.write(
        serializeSystemdEnvironmentLine(process.argv[3] ?? "", value),
      );
      return;
    }
    if (command === "nonempty") {
      const targetPath = process.argv[3] ?? "";
      const names = process.argv.slice(4);
      if (names.length === 0) {
        throw new Error("SYSTEMD_ENVIRONMENT_NAME_INVALID");
      }
      const contents = decodeUtf8File(
        readFileSync(targetPath),
        "SYSTEMD_ENVIRONMENT_FILE_INVALID",
      );
      for (const name of names) {
        if (lookupSystemdEnvironmentValue(contents, name).length === 0) {
          throw new Error("SYSTEMD_ENVIRONMENT_VALUE_EMPTY");
        }
      }
      return;
    }
    if (command === "equals") {
      const expected = await readStdinBounded(MAX_VALUE_BYTES);
      const contents = decodeUtf8File(
        readFileSync(process.argv[3] ?? ""),
        "SYSTEMD_ENVIRONMENT_FILE_INVALID",
      );
      if (
        lookupSystemdEnvironmentValue(contents, process.argv[4] ?? "") !==
        expected
      ) {
        throw new Error("SYSTEMD_ENVIRONMENT_VALUE_MISMATCH");
      }
      return;
    }
    if (command === "reconcile" || command === "install") {
      reconcileSystemdEnvironmentFile({
        targetPath: process.argv[3] ?? "",
        replacementNamesPath: process.argv[4] ?? "",
        assignmentsPath: process.argv[5] ?? "",
        preserveUnplanned: command === "reconcile",
      });
      return;
    }
    throw new Error("SYSTEMD_ENVIRONMENT_COMMAND_INVALID");
  } catch (error) {
    // error-policy:J1 the CLI boundary emits only a closed diagnostic code and
    // a non-success status; it never reflects file contents or rejected values.
    process.stderr.write(
      `[systemd-environment-line] rejected: ${safeErrorCode(error)}\n`,
    );
    process.exitCode = 78;
  }
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
