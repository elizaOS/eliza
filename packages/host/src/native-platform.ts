import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Build variant — store vs direct.
 *
 * `store` builds (Mac App Store, Microsoft Store, Flathub, etc.) run inside
 * an OS sandbox that forbids forking arbitrary user-installed binaries and
 * restricts filesystem reach to the app's container plus user-granted folders.
 *
 * `direct` builds are the unrestricted user-download artifacts.
 *
 * Resolution: `ELIZA_BUILD_VARIANT` → default `direct`. The variant is
 * decided at process start; we do not refresh it mid-run.
 */

export const BUILD_VARIANTS = ["store", "direct"] as const;
export type BuildVariant = (typeof BUILD_VARIANTS)[number];

export const DEFAULT_BUILD_VARIANT: BuildVariant = "direct";

const VARIANT_VALUES: ReadonlySet<BuildVariant> = new Set(BUILD_VARIANTS);

const DIRECT_DOWNLOAD_URL = "https://eliza.so/download";

let resolvedVariant: BuildVariant | null = null;

function readVariantFromEnv(): BuildVariant {
  const raw = process.env.ELIZA_BUILD_VARIANT ?? "";
  const normalized = raw.trim().toLowerCase();
  if (VARIANT_VALUES.has(normalized as BuildVariant)) {
    return normalized as BuildVariant;
  }
  return "direct";
}

export function getBuildVariant(): BuildVariant {
  if (resolvedVariant === null) {
    resolvedVariant = readVariantFromEnv();
  }
  return resolvedVariant;
}

export function getDirectDownloadUrl(): string {
  return DIRECT_DOWNLOAD_URL;
}

export function isStoreBuild(): boolean {
  return getBuildVariant() === "store";
}

export function isDirectBuild(): boolean {
  return getBuildVariant() === "direct";
}

/** Test hook only. Resets cached variant so tests can swap env vars. */
export function _resetBuildVariantForTests(): void {
  resolvedVariant = null;
}

export function isLocalCodeExecutionAllowed(): boolean {
  return getBuildVariant() === "direct";
}

export function buildStoreVariantBlockedMessage(featureLabel: string): string {
  return [
    `${featureLabel} requires the direct download build of Eliza.`,
    `Store-distributed builds run in an OS sandbox that blocks forking user-installed CLIs.`,
    `To use this feature, install from ${getDirectDownloadUrl()}.`,
  ].join(" ");
}

/**
 * Load-path allow policy for native libraries such as macOS bridge dylibs.
 * Direct builds accept existing files, while store builds require the resolved
 * library to keep an expected basename inside a trusted signed app bundle.
 */

export type NativeLibraryCandidate = {
  label?: string;
  path: string;
};

export type NativeLibraryPolicyOptions = {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  expectedBasename: string | readonly string[];
  moduleDir?: string;
  warn?: (message: string) => void;
};

function isStoreBuildVariant(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ELIZA_BUILD_VARIANT?.trim();
  return raw?.toLowerCase() === "store";
}

function realpath(value: string): string | null {
  try {
    return realpathSync.native(value);
  } catch {
    try {
      return realpathSync(value);
    } catch {
      // error-policy:J4 an unavailable candidate is an explicit miss at this
      // probe boundary; callers continue to the next declared candidate.
      return null;
    }
  }
}

function isWithinPath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function findMacAppBundleRoot(value: string | undefined): string | null {
  if (!value) return null;
  const absolute = path.resolve(value);
  const parts = absolute.split(path.sep);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    if (parts[index]?.endsWith(".app")) {
      return parts.slice(0, index + 1).join(path.sep) || path.sep;
    }
  }
  return null;
}

function trustedBundleRoot(opts: NativeLibraryPolicyOptions): string | null {
  // The running app is authoritative. A module in a different bundle must not
  // authorize that other bundle when the executable already identifies ours.
  return (
    findMacAppBundleRoot(opts.execPath ?? process.execPath) ??
    findMacAppBundleRoot(opts.moduleDir)
  );
}

function candidateLabel(candidate: NativeLibraryCandidate): string {
  return candidate.label
    ? `${candidate.label} (${candidate.path})`
    : candidate.path;
}

function expectedBasenames(opts: NativeLibraryPolicyOptions): Set<string> {
  return new Set(
    (Array.isArray(opts.expectedBasename)
      ? opts.expectedBasename
      : [opts.expectedBasename]
    ).map((name) => name.trim()),
  );
}

function expectedBasenameLabel(expected: Set<string>): string {
  return [...expected].join(", ");
}

export function resolveNativeLibraryCandidate(
  candidate: NativeLibraryCandidate,
  opts: NativeLibraryPolicyOptions,
): string | null {
  const rawPath = candidate.path.trim();
  if (!rawPath) return null;

  const resolvedPath = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : typeof opts.moduleDir === "string" && opts.moduleDir.length > 0
      ? path.resolve(opts.moduleDir, rawPath)
      : null;
  if (!resolvedPath) {
    opts.warn?.(
      `Rejected native library candidate ${candidateLabel(candidate)}: relative path cannot be resolved without a module directory.`,
    );
    return null;
  }

  if (!existsSync(resolvedPath)) return null;

  if (!isStoreBuildVariant(opts.env)) {
    return realpath(resolvedPath) ?? resolvedPath;
  }

  const expected = expectedBasenames(opts);
  if (!expected.has(path.basename(resolvedPath))) {
    opts.warn?.(
      `Rejected native library candidate ${candidateLabel(candidate)} for store build: expected ${expectedBasenameLabel(expected)}.`,
    );
    return null;
  }

  const candidateRealpath = realpath(resolvedPath);
  if (!candidateRealpath) return null;

  if (!expected.has(path.basename(candidateRealpath))) {
    opts.warn?.(
      `Rejected native library candidate ${candidateLabel(candidate)} for store build: realpath basename is not ${expectedBasenameLabel(expected)}.`,
    );
    return null;
  }

  const bundleRoot = trustedBundleRoot(opts);
  const root = bundleRoot ? realpath(bundleRoot) : null;

  if (!root) {
    opts.warn?.(
      `Rejected native library candidate ${candidateLabel(candidate)} for store build: no trusted .app bundle root was found.`,
    );
    return null;
  }

  if (!isWithinPath(path.join(root, "Contents"), candidateRealpath)) {
    opts.warn?.(
      `Rejected native library candidate ${candidateLabel(candidate)} for store build: library is outside the signed app bundle.`,
    );
    return null;
  }

  return candidateRealpath;
}
