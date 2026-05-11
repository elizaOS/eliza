import * as posix from "node:path/posix";

export interface NormalizedPath {
  /** Path normalized to POSIX separators, no leading slash, no `..` segments. */
  relative: string;
  /** Segments split on `/`. Useful for backends that take an array. */
  segments: string[];
}

const ABSOLUTE_WINDOWS = /^[a-zA-Z]:[\\/]/;

/**
 * Reject obviously hostile inputs and produce a canonical POSIX-style relative path
 * that callers can safely append to a backend root (Documents/, workspace/...).
 *
 * Rejects:
 *   - empty paths
 *   - absolute POSIX paths (`/foo`)
 *   - absolute Windows paths (`C:/foo`)
 *   - any path containing a `..` segment after normalization
 *   - paths containing NUL bytes
 */
export interface NormalizeOptions {
  /** When true, an empty string or `"."` is treated as the root path. */
  allowRoot?: boolean;
}

export function normalizeDevicePath(
  input: string,
  options: NormalizeOptions = {},
): NormalizedPath {
  if (typeof input !== "string") {
    throw new Error("path is required");
  }
  if (input.length === 0) {
    if (options.allowRoot === true) {
      return { relative: "", segments: [] };
    }
    throw new Error("path is required");
  }
  if (input.includes("\0")) {
    throw new Error("path contains NUL byte");
  }
  const unified = input.replace(/\\/g, "/");
  if (unified.startsWith("/")) {
    throw new Error(`absolute paths are not allowed: ${input}`);
  }
  if (ABSOLUTE_WINDOWS.test(unified)) {
    throw new Error(`absolute paths are not allowed: ${input}`);
  }
  if (unified.split("/").some((seg) => seg === "..")) {
    throw new Error(`path traversal is not allowed: ${input}`);
  }
  const normalized = posix.normalize(unified);
  if (normalized === "." || normalized === "") {
    if (options.allowRoot === true) {
      return { relative: "", segments: [] };
    }
    throw new Error(`path resolves to the root: ${input}`);
  }
  const segments = normalized.split("/").filter((seg) => seg.length > 0);
  for (const seg of segments) {
    if (seg === "..") {
      throw new Error(`path traversal is not allowed: ${input}`);
    }
    if (seg === ".") {
      throw new Error(`path contains '.' segment: ${input}`);
    }
  }
  return { relative: segments.join("/"), segments };
}
