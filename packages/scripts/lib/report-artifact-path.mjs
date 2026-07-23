/**
 * Resolves generated test evidence only within the repository's reports tree.
 *
 * Producers may replace their exact output file, but they never traverse a
 * symlinked parent or accept an absolute/traversal path that could overwrite
 * source, configuration, or an external filesystem location.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const WINDOWS_DEVICE_NAME =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)$/i;

function assertSafeDirectory(directory, relative, label) {
  try {
    const metadata = lstatSync(directory);
    if (metadata.isSymbolicLink()) {
      throw new Error(`${label} has a symlinked parent: ${relative}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`${label} parent is not a directory: ${relative}`);
    }
  } catch (error) {
    // error-policy:J3 ENOENT is the explicit "not created yet" state — a
    // missing parent cannot be a symlink and is built fresh by the writer;
    // every other lstat failure propagates.
    if (error?.code !== "ENOENT") throw error;
  }
}

function assertSafeParents(reportsRoot, absolute, label) {
  assertSafeDirectory(reportsRoot, "reports", label);
  let current = path.dirname(absolute);
  while (current !== reportsRoot) {
    const relative = path.relative(reportsRoot, current);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`${label} escapes the repository reports directory`);
    }
    assertSafeDirectory(current, `reports/${relative}`, label);
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`${label} could not be contained within the repository`);
    }
    current = parent;
  }
}

/** Return canonical relative and absolute paths for one report artifact. */
export function resolveReportArtifactPath(
  repoRoot,
  value,
  { extension, label },
) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new Error(`${label} requires a non-empty file path`);
  }
  const normalizedSlashes = value.split("\\").join("/");
  if (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(normalizedSlashes) ||
    /^[A-Za-z]:\//.test(normalizedSlashes)
  ) {
    throw new Error(`${label} must be repository-relative under reports/`);
  }
  const segments = normalizedSlashes.split("/");
  if (
    segments.includes("..") ||
    segments.includes(".") ||
    segments.includes("")
  ) {
    throw new Error(`${label} may not contain empty or traversal segments`);
  }
  for (const segment of segments) {
    if (segment.includes(":")) {
      throw new Error(
        `${label} may not contain drive-relative or stream names`,
      );
    }
    if (/[. ]$/.test(segment)) {
      throw new Error(
        `${label} may not contain Windows-normalized trailing dots or spaces`,
      );
    }
    const deviceStem = segment.split(".")[0];
    if (WINDOWS_DEVICE_NAME.test(deviceStem)) {
      throw new Error(`${label} may not contain a Windows device name`);
    }
  }
  const relative = path.posix.normalize(normalizedSlashes);
  if (segments[0] !== "reports" || segments.length < 2) {
    throw new Error(`${label} must be under reports/`);
  }
  if (
    path.posix.extname(relative) !== extension ||
    path.posix.basename(relative) === extension
  ) {
    throw new Error(`${label} must name a ${extension} file`);
  }
  const root = path.resolve(repoRoot);
  const reportsRoot = path.resolve(root, "reports");
  const absolute = path.resolve(reportsRoot, ...segments.slice(1));
  const containment = path.relative(reportsRoot, absolute);
  if (
    containment === "" ||
    containment.startsWith("..") ||
    path.isAbsolute(containment)
  ) {
    throw new Error(`${label} escapes the repository reports directory`);
  }
  assertSafeParents(reportsRoot, absolute, label);
  return { absolute, relative };
}

/**
 * Atomically replace one file through an exclusive, unpredictable sibling.
 *
 * Tests may inject the token and pid to prove a pre-created symlink is refused.
 */
export function atomicWriteFileSync(
  destination,
  data,
  { mode = 0o600, pid = process.pid, randomToken } = {},
) {
  const token = randomToken ?? randomBytes(16).toString("hex");
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
    throw new Error("atomic report token must be 8-128 safe characters");
  }
  const temporary = `${destination}.${pid}.${token}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      mode,
    );
    writeFileSync(descriptor, data);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, destination);
  } catch (error) {
    // error-policy:J6 best-effort teardown of the exclusive temporary before
    // the original write failure is rethrown unchanged.
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** Serialize one JSON report through the shared exclusive atomic writer. */
export function atomicWriteJsonSync(destination, value, options) {
  atomicWriteFileSync(
    destination,
    `${JSON.stringify(value, null, 2)}\n`,
    options,
  );
}
