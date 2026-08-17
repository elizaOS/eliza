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

const MAX_CANDIDATE_PATHS = 24;
const MAX_PROBE_URLS = 5;
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
      if (out.size >= MAX_CANDIDATE_PATHS) return [...out];
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
  for (const candidate of input.candidatePaths.slice(0, MAX_CANDIDATE_PATHS)) {
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
  return [...urls].slice(0, MAX_PROBE_URLS * 2);
}

/**
 * Probe candidate URLs and return those answering 200 — the same epistemic
 * status as router-probed URLs: verified by request, never by narration.
 * Bounded and timeout-guarded; probe failures simply do not verify.
 */
export async function probeMappedUrls(
  urls: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const verified: string[] = [];
  for (const url of urls.slice(0, MAX_PROBE_URLS)) {
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (response.ok) verified.push(url);
    } catch {
      // error-policy:J3 an unreachable candidate is explicitly unverified —
      // absence from the result is the honest outcome, never a fake 200.
    }
  }
  return verified;
}
