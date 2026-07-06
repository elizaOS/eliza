/**
 * Content-addressed cache for vision-qa results so re-runs over an unchanged
 * screenshot and question set cost nothing. The key is two hashes: sha256 of
 * the ORIGINAL image bytes, and sha256 of the canonical JSON of
 * `{model, backend, questions, dimensions}`. Dimensions bind the downscaled
 * pixels actually sent to the model, so a caller changing `maxEdge` cannot reuse
 * an answer produced from a different raster. Using the foundation's
 * `canonicalJson` for the question key makes it order- and whitespace-stable,
 * so semantically identical question sets hit the same entry. Layout:
 *   <root>/.vision-qa-cache/<image-sha>/<query-sha>.json
 * A hit returns the stored result with `cached: true`; a corrupt cache file is
 * treated as a miss (re-ask) rather than crashing the run — the cache is an
 * optimization, not a source of truth.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "../canonical.ts";
import type {
  AskResult,
  ImageDimensions,
  VisionBackend,
  VisionQuestion,
} from "./types.ts";

export const CACHE_DIR_NAME = ".vision-qa-cache";

/** sha256 of the canonical `{model, backend, questions}` — the query key. */
export function queryHash(
  model: string,
  backend: VisionBackend,
  questions: VisionQuestion[],
  dimensions?: ImageDimensions,
): string {
  const canonical = canonicalJson({ model, backend, questions, dimensions });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Absolute path of the cache file for one (image, query) pair. */
export function cacheFilePath(
  cacheRoot: string,
  imageSha256: string,
  query: string,
): string {
  return path.join(cacheRoot, CACHE_DIR_NAME, imageSha256, `${query}.json`);
}

/**
 * Return a cached result for this (image, query) pair, or null on miss. A file
 * that fails to parse as an `AskResult` is a miss: the cache is disposable, so a
 * malformed entry means re-ask, and the fresh write overwrites it.
 */
export function readCache(
  cacheRoot: string,
  imageSha256: string,
  query: string,
): AskResult | null {
  const file = cacheFilePath(cacheRoot, imageSha256, query);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    // error-policy:J4 a missing cache file is the common case, not an error;
    // it degrades to a live ask.
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J4 a corrupt cache entry is disposable — treat as a miss and
    // let the fresh result overwrite it.
    return null;
  }
  if (!isAskResult(parsed)) return null;
  return parsed;
}

/** Persist a result for this (image, query) pair, creating the cache dirs. */
export function writeCache(
  cacheRoot: string,
  imageSha256: string,
  query: string,
  result: AskResult,
): void {
  const file = cacheFilePath(cacheRoot, imageSha256, query);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${canonicalJson(result)}\n`, "utf8");
}

/** Structural guard: only accept a parsed cache file that is a real result. */
function isAskResult(value: unknown): value is AskResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.answers) && typeof record.provenance === "object";
}
