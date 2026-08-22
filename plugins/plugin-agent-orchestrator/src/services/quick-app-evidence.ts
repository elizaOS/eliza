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
import { logger } from "@elizaos/core";
import { durableProjection } from "./durable-content-store.js";
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

// Sanity CEILINGS, not working caps: generous enough that a real quick-app
// session workdir is enumerated EXHAUSTIVELY (the old depth-3/64-entry caps
// silently parked deep or many-file deliverables as "no evidence"). When a
// pathological tree does trip a ceiling, the walk records exactly what it did
// not traverse and reports it — never a silent cut.
const ENUMERATE_MAX_DEPTH = 16;
const ENUMERATE_MAX_ENTRIES = 4_096;
/** NAMED exclusion set — a semantic filter, not a size cap. Orchestration
 *  plumbing written into the workdir for the child (AGENTS.md/CLAUDE.md) plus
 *  vendor/VCS internals that are never the deliverable. Deliberately NOT a
 *  blanket dot-prefix skip: dot-path deliverables (.github/workflows/ci.yml,
 *  .env.example, .eslintrc.json) are legitimate candidates. The rendered
 *  FS-VERIFIED FILES header names this rule so "not listed" cannot be read as
 *  "does not exist". */
const ENUMERATE_SKIP = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".yarn",
  ".DS_Store",
]);

/** Full enumeration result: candidates plus the explicit continuation note
 *  for anything a sanity ceiling kept the walk from visiting. */
export interface WorkdirEnumeration {
  /** Workdir-relative candidate files, sorted (deterministic). */
  candidates: string[];
  /** Workdir-relative paths the walk did NOT visit because a ceiling
   *  tripped — directories not descended into (trailing `/`) and files not
   *  recorded. Empty when the walk was exhaustive. */
  notTraversed: string[];
  /** True iff `notTraversed` is non-empty. */
  truncated: boolean;
  limits: { maxDepth: number; maxEntries: number };
}

/**
 * Enumerate the session workdir directly as a candidate source. A worker that
 * ends its run with an empty final reply leaves NOTHING to mine claims from,
 * and a working build then parks with "no evidence" (live 2026-08-19: built
 * dice-roller page reported as ghosted + parked). Enumeration only nominates
 * candidates; collectFsObservedFiles still applies the mtime-after-start gate
 * before anything counts as evidence. Entries are visited in sorted order so
 * a ceiling, if ever hit, cuts deterministically — and everything not visited
 * is recorded in `notTraversed` (the pagination-contract continuation note).
 */
export function enumerateWorkdirCandidatesDetailed(
  workdir: string,
  limits: { maxDepth?: number; maxEntries?: number } = {},
): WorkdirEnumeration {
  const maxDepth = limits.maxDepth ?? ENUMERATE_MAX_DEPTH;
  const maxEntries = limits.maxEntries ?? ENUMERATE_MAX_ENTRIES;
  const root = path.resolve(workdir);
  const candidates: string[] = [];
  const notTraversed: string[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      // error-policy:J3 an unreadable directory nominates no candidates; the
      // claim-mining sources still apply.
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (ENUMERATE_SKIP.has(entry.name)) continue;
      const absolute = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolute);
      if (entry.isDirectory()) {
        if (depth + 1 > maxDepth) {
          notTraversed.push(`${relativePath}/`);
          continue;
        }
        walk(absolute, depth + 1);
      } else if (entry.isFile()) {
        if (candidates.length >= maxEntries) {
          notTraversed.push(relativePath);
          continue;
        }
        candidates.push(relativePath);
      }
    }
  };
  walk(root, 0);
  return {
    candidates: candidates.sort(),
    notTraversed: notTraversed.sort(),
    truncated: notTraversed.length > 0,
    limits: { maxDepth, maxEntries },
  };
}

/**
 * Candidate list for callers that only need the paths. A tripped sanity
 * ceiling is never silent: the explicit continuation note (what was NOT
 * traversed) is logged in full detail before the bounded list is returned.
 */
export function enumerateWorkdirCandidates(workdir: string): string[] {
  const enumeration = enumerateWorkdirCandidatesDetailed(workdir);
  if (enumeration.truncated) {
    logger.warn(
      {
        workdir,
        limits: enumeration.limits,
        candidateCount: enumeration.candidates.length,
        notTraversedCount: enumeration.notTraversed.length,
        notTraversed: enumeration.notTraversed,
      },
      "[quick-app-evidence] workdir enumeration hit a sanity ceiling — the listed paths were NOT traversed and their files were not nominated as evidence candidates",
    );
  }
  return enumeration.candidates;
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

/** Extensions that are binary BY CONSTRUCTION — never inlined as text. Such
 *  assets stay named in the FS-VERIFIED FILES list, and the rendered section
 *  header names this rule, so their absence from the contents section reads
 *  as "not a text file", never as "does not exist". Everything else is read
 *  and content-sniffed rather than gated on an extension allowlist (the old
 *  seven-extension allowlist silently withheld .py/.ts/.yml/... deliverables
 *  and content criteria on them failed as unproven narration). */
const BINARY_CONTENT_RE =
  /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|zip|gz|tgz|bz2|xz|7z|rar|pdf|mp[34]|m4[av]|mov|avi|webm|ogg|wav|flac|exe|dll|so|dylib|class|jar|wasm|sqlite3?|db|bin)$/i;

/** Per-file view budget for the judge's contents section. A file under the
 *  budget is inlined WHOLE (the normal quick-app case); an oversized file is
 *  persisted whole to the durable content store FIRST and its view ends with
 *  a marker naming `GET /api/orchestrator/content/<sha256>` — content is
 *  paged, never lost. */
const PER_FILE_CONTENT_BUDGET_CHARS = 24_000;

function projectFileContent(content: string): string {
  try {
    return durableProjection(content, PER_FILE_CONTENT_BUDGET_CHARS).view;
  } catch {
    // error-policy:J4 a durable-store write failure must not sink evidence
    // assembly — fall back to the COMPLETE text (uncapped) rather than
    // reintroducing a silent cut.
    return content;
  }
}

/**
 * Read the complete contents of fs-verified text files so content
 * criteria are judged against the real file text. Same epistemic status as
 * the stat probe: the orchestrator reads the bytes itself; worker narration
 * never enters. Unreadable files contribute no entry, never a fabricated one.
 * Text detection is by sniff (no NUL byte in the decoded text), not by an
 * extension allowlist; only known-binary extensions skip the read outright.
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
    if (BINARY_CONTENT_RE.test(file)) continue;
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    const content = read(absolute);
    if (content === undefined) continue;
    // Binary sniff: a NUL byte in the utf8-decoded text means this is not a
    // text deliverable — it stays listed (FS-VERIFIED FILES) but not inlined.
    if (content.includes("\u0000")) continue;
    out.push({
      path: relative,
      content: projectFileContent(content),
    });
  }
  return out;
}
