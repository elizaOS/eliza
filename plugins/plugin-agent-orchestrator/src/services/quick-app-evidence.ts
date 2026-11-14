/**
 * Deterministic evidence recovery for quick-app completions (#20794 live
 * residual). On adapter paths that fold tool results into messages, a
 * completed one-file app leaves the evidence bundle starved: no structured
 * write ledger, no router-probed URL, no changeset — so the deterministic
 * pre-pass sees nothing and working deliverables fall to the judge with
 * "no evidence" and park.
 *
 * Two honest facts the orchestrator can OBSERVE directly, without trusting
 * worker narration: a claimed file either exists in the session workdir with
 * an mtime after the session started (fs stat — direct inspection), or it
 * does not; and a route-mapped public URL either answers HTTP 200 right now
 * (real probe) or it does not. Claims select WHAT to inspect; only the
 * inspection result becomes evidence.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkdirRouteUrlMapping } from "./task-agent-routing.js";

const PROBE_TIMEOUT_MS = 5_000;

/** Absolute or workdir-relative file-path tokens in worker output. */
const PATH_CANDIDATE_RE =
  /(?:^|[\s"'`(=])((?:\/|(?:[\w.-]+\/)+)[\w./-]*[\w-]\.[A-Za-z]{1,8})(?=$|[\s"'`),])/gm;

/** Mine candidate file paths from worker-reported text. Claims only — the
 *  caller verifies each against the real filesystem before anything counts. */
export function mineCandidatePaths(texts: readonly string[]): string[] {
  const out = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PATH_CANDIDATE_RE)) {
      const candidate = match[1];
      if (candidate) out.add(candidate);
    }
  }
  return [...out];
}

export interface FsObservedFilesInput {
  workdir: string;
  candidatePaths: readonly string[];
  /** Epoch ms the session started; only newer mtimes count as session work. */
  sessionStartedAt: number;
  /** Test seam over fs.statSync. */
  statImpl?: (absolutePath: string) => { mtimeMs: number } | undefined;
}

function defaultStat(absolutePath: string): { mtimeMs: number } | undefined {
  try {
    const stat = fs.statSync(absolutePath);
    return stat.isFile() ? { mtimeMs: stat.mtimeMs } : undefined;
  } catch {
    // error-policy:J3 an unreadable/absent candidate is explicitly not
    // observed evidence — the caller treats it as unverified, never as a file.
    return undefined;
  }
}

/**
 * Verify candidate paths by direct filesystem inspection: the file must
 * resolve INSIDE the session workdir (no traversal) and carry an mtime at or
 * after session start. Returns workdir-relative paths, deterministic order.
 */
export function collectFsObservedFiles(input: FsObservedFilesInput): string[] {
  const stat = input.statImpl ?? defaultStat;
  const root = path.resolve(input.workdir);
  const observed: string[] = [];
  for (const candidate of input.candidatePaths) {
    const absolute = path.resolve(root, candidate);
    const relative = path.relative(root, absolute);
    if (
      relative === "" ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      continue;
    }
    const info = stat(absolute);
    if (!info) continue;
    if (info.mtimeMs + 1 < input.sessionStartedAt) continue;
    observed.push(relative);
  }
  return [...new Set(observed)].sort();
}

/**
 * Map workdir-relative files to their public URLs through the route's
 * operator-configured `urlMappings`. `index.html` additionally maps to its
 * directory URL — the address a person would actually open.
 */
export function deriveRouteMappedUrls(
  relativeFiles: readonly string[],
  urlMappings: readonly WorkdirRouteUrlMapping[] | undefined,
): string[] {
  if (!urlMappings || urlMappings.length === 0) return [];
  const urls = new Set<string>();
  for (const file of relativeFiles) {
    for (const mapping of urlMappings) {
      const localPrefix = mapping.localPath
        .replace(/^\.?\//, "")
        .replace(/\/+$/, "");
      const normalized = file.replace(/^\.?\//, "");
      if (localPrefix.length > 0 && !normalized.startsWith(`${localPrefix}/`)) {
        continue;
      }
      const remainder =
        localPrefix.length > 0
          ? normalized.slice(localPrefix.length + 1)
          : normalized;
      const base = mapping.urlPrefix.replace(/\/+$/, "");
      urls.add(`${base}/${remainder}`);
      if (remainder.endsWith("/index.html")) {
        urls.add(`${base}/${remainder.slice(0, -"index.html".length)}`);
      } else if (remainder === "index.html") {
        urls.add(`${base}/`);
      }
    }
  }
  return [...urls];
}

/**
 * Probe candidate URLs and return those answering 200 — the same epistemic
 * status as router-probed URLs: verified by request, never by narration.
 * Timeout-guarded; probe failures simply do not verify.
 */
export async function probeMappedUrls(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const results = await Promise.all(
    urls.map(async (url): Promise<string | undefined> => {
      try {
        const response = await fetchImpl(url, {
          method: "GET",
          redirect: "follow",
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        });
        return response.ok ? url : undefined;
      } catch {
        // error-policy:J3 an unreachable candidate is explicitly unverified —
        // absence from the result is the honest outcome, never a fake 200.
        return undefined;
      }
    }),
  );
  return results.filter((url): url is string => url !== undefined);
}

/** Tooling manifests that make a check-class criterion RUNNABLE where the
 *  deliverable lives. Grouped by the check they enable. */
const TYPECHECK_SURFACE_FILES = [
  "tsconfig.json",
  "tsconfig.base.json",
  "jsconfig.json",
];
const LINT_SURFACE_FILES = [
  "biome.json",
  "biome.jsonc",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  "eslint.config.js",
  "eslint.config.mjs",
];
const TEST_SURFACE_FILES = [
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.js",
  "jest.config.ts",
  "package.json",
];
const TEST_FILE_RE = /\.(?:test|spec)\.[jt]sx?$/i;

export interface CheckSurfaces {
  typecheck: boolean;
  lint: boolean;
  test: boolean;
}

/**
 * Detect which check classes are RUNNABLE for the verified deliverable, by
 * direct inspection of the deliverable's OWN directories — deliberately not
 * the workdir root. A route workdir's root tooling (e.g. the static server's
 * Next.js package.json/tsconfig) governs the server code, not the static app
 * bundles it serves; a vanilla script.js beside index.html with no manifest
 * in its directory is exactly as untypecheckable as the HTML (#20794
 * dawn-mesa). Deliverables that live AT a tooling boundary (a file next to
 * package.json / tsconfig, or a sub-package with its own manifests) detect as
 * runnable and keep the strict path.
 */
export function detectCheckSurfaces(
  workdir: string,
  relativeFiles: readonly string[],
  existsImpl?: (absolutePath: string) => boolean,
): CheckSurfaces {
  const exists =
    existsImpl ??
    ((absolutePath: string): boolean => {
      try {
        return fs.statSync(absolutePath).isFile();
      } catch {
        // error-policy:J3 an unreadable marker is explicitly not a surface
        return false;
      }
    });
  const root = path.resolve(workdir);
  const dirs = new Set<string>();
  for (const file of relativeFiles) {
    const dir = path.resolve(root, path.dirname(file));
    const relative = path.relative(root, dir);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    dirs.add(dir);
  }
  const anyMarker = (names: readonly string[]): boolean => {
    for (const dir of dirs) {
      for (const name of names) {
        if (exists(path.join(dir, name))) return true;
      }
    }
    return false;
  };
  return {
    typecheck: anyMarker(TYPECHECK_SURFACE_FILES),
    lint: anyMarker(LINT_SURFACE_FILES),
    test:
      anyMarker(TEST_SURFACE_FILES) ||
      relativeFiles.some((file) => TEST_FILE_RE.test(file)),
  };
}

/** Text-asset extensions worth showing the judge verbatim. */
const TEXT_CONTENT_RE = /\.(?:html?|css|js|svg|md|txt|json)$/i;

/**
 * Read the complete contents of fs-verified text files so content
 * criteria are judged against the real file text. Same epistemic status as
 * the stat probe: the orchestrator reads the bytes itself; worker narration
 * never enters. Unreadable files contribute no entry, never a fabricated one.
 */
export function readFsVerifiedContents(
  workdir: string,
  relativeFiles: readonly string[],
  readImpl?: (absolutePath: string) => string | undefined,
): Array<{ path: string; content: string }> {
  const read =
    readImpl ??
    ((absolutePath: string): string | undefined => {
      try {
        return fs.readFileSync(absolutePath, "utf8");
      } catch {
        // error-policy:J3 an unreadable file is explicitly absent evidence
        return undefined;
      }
    });
  const root = path.resolve(workdir);
  const out: Array<{ path: string; content: string }> = [];
  for (const file of relativeFiles) {
    if (!TEXT_CONTENT_RE.test(file)) continue;
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const content = read(absolute);
    if (content === undefined) continue;
    out.push({
      path: relative,
      content,
    });
  }
  return out;
}
