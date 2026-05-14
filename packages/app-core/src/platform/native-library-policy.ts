import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export type NativeLibraryCandidate = {
  label?: string;
  path: string;
};

export type NativeLibraryPolicyOptions = {
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  expectedBasename: string;
  moduleDir: string;
  warn?: (message: string) => void;
};

function isStoreBuildVariant(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw =
    env.ELIZA_BUILD_VARIANT?.trim() || env.MILADY_BUILD_VARIANT?.trim();
  return raw?.toLowerCase() === "store";
}

function realpath(value: string): string | null {
  try {
    return realpathSync.native(value);
  } catch {
    try {
      return realpathSync(value);
    } catch {
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

function trustedBundleRoots(opts: NativeLibraryPolicyOptions): string[] {
  const roots = [
    findMacAppBundleRoot(opts.execPath ?? process.execPath),
    findMacAppBundleRoot(opts.moduleDir),
  ];
  return [...new Set(roots.filter((root): root is string => root !== null))];
}

function candidateLabel(candidate: NativeLibraryCandidate): string {
  return candidate.label
    ? `${candidate.label} (${candidate.path})`
    : candidate.path;
}

export function resolveNativeLibraryCandidate(
  candidate: NativeLibraryCandidate,
  opts: NativeLibraryPolicyOptions,
): string | null {
  const rawPath = candidate.path.trim();
  if (!rawPath) return null;

  const resolvedPath = path.isAbsolute(rawPath)
    ? path.normalize(rawPath)
    : path.resolve(opts.moduleDir, rawPath);

  if (!existsSync(resolvedPath)) return null;

  if (!isStoreBuildVariant(opts.env)) {
    return resolvedPath;
  }

  if (path.basename(resolvedPath) !== opts.expectedBasename) {
    opts.warn?.(
      `Rejected native library candidate ${candidateLabel(candidate)} for store build: expected ${opts.expectedBasename}.`,
    );
    return null;
  }

  const candidateRealpath = realpath(resolvedPath);
  if (!candidateRealpath) return null;

  const roots = trustedBundleRoots(opts)
    .map((root) => realpath(root))
    .filter((root): root is string => root !== null);

  if (roots.length === 0) {
    opts.warn?.(
      `Rejected native library candidate ${candidateLabel(candidate)} for store build: no trusted .app bundle root was found.`,
    );
    return null;
  }

  if (!roots.some((root) => isWithinPath(root, candidateRealpath))) {
    opts.warn?.(
      `Rejected native library candidate ${candidateLabel(candidate)} for store build: library is outside the signed app bundle.`,
    );
    return null;
  }

  return candidateRealpath;
}

export function resolveFirstNativeLibraryCandidate(
  candidates: NativeLibraryCandidate[],
  opts: NativeLibraryPolicyOptions,
): string | null {
  for (const candidate of candidates) {
    const resolved = resolveNativeLibraryCandidate(candidate, opts);
    if (resolved) return resolved;
  }
  return null;
}

export const nativeLibraryPolicyInternalsForTest = {
  findMacAppBundleRoot,
  isStoreBuildVariant,
  isWithinPath,
};
