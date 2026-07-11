/**
 * Public-route audit (#9948).
 *
 * Every `public: true` route bypasses the central `isAuthorized()` gate
 * (`runtime-plugin-routes.ts`: `route.public !== true && !isAuthorized()`), so a
 * new one is a new unauthenticated surface. Normal test runs scan the reviewed
 * baseline files plus branch-changed source files; baseline regeneration walks
 * the full source tree. The companion test pins the set against a checked-in
 * baseline so a NEW public route can't be added without an explicit, reviewed
 * baseline entry (regenerate with `UPDATE_PUBLIC_ROUTE_BASELINE=1`).
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/agent/src/api → repo root is four levels up.
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");
const BASELINE_PATH = join(HERE, "public-route-audit.baseline.json");

const SCAN_ROOTS = ["packages", "plugins"];
const SKIP_DIR = new Set([
  "node_modules",
  "dist",
  "build",
  "storybook-static",
  ".turbo",
  "coverage",
  ".next",
  "out",
  "__tests__",
  "__fixtures__",
  "__mocks__",
]);
const SKIP_FILE = /\.(test|spec|d)\.tsx?$/;
// This module + its test legitimately contain the literal "public: true" search
// string; excluding them keeps the audit from matching itself.
const SELF = "public-route-audit";

type WalkDirent = {
  name: string;
  isDirectory(): boolean;
};

function* walk(dir: string): Generator<string> {
  let entries: WalkDirent[];
  try {
    entries = readdirSync(dir, { encoding: "utf8", withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (
      (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
      !SKIP_FILE.test(entry.name) &&
      !entry.name.startsWith(SELF)
    ) {
      yield join(dir, entry.name);
    }
  }
}

function isCandidateSourceFile(file: string): boolean {
  const normalized = file.split(sep).join("/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!(basename.endsWith(".ts") || basename.endsWith(".tsx"))) return false;
  if (SKIP_FILE.test(basename) || basename.startsWith(SELF)) return false;
  return !normalized.split("/").some((segment) => SKIP_DIR.has(segment));
}

function gitOutput(args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function baselineCandidateFiles(): string[] {
  try {
    const baseline = JSON.parse(
      readFileSync(BASELINE_PATH, "utf8"),
    ) as string[];
    return baseline
      .map((key) => key.split("::")[0])
      .filter((file, index, files) => files.indexOf(file) === index)
      .filter(isCandidateSourceFile)
      .map((file) => join(REPO_ROOT, file));
  } catch {
    return [];
  }
}

function splitGitPathOutput(output: string | null): string[] {
  if (!output) return [];
  return output.split("\0").filter(Boolean);
}

function changedCandidateFiles(): string[] {
  const candidates = [
    ...splitGitPathOutput(
      gitOutput([
        "diff",
        "--name-only",
        "--diff-filter=ACMR",
        "-z",
        "--",
        ...SCAN_ROOTS,
      ]),
    ),
    ...splitGitPathOutput(
      gitOutput([
        "diff",
        "--cached",
        "--name-only",
        "--diff-filter=ACMR",
        "-z",
        "--",
        ...SCAN_ROOTS,
      ]),
    ),
    ...splitGitPathOutput(
      gitOutput([
        "diff",
        "--name-only",
        "--diff-filter=ACMR",
        "-z",
        "origin/develop...HEAD",
        "--",
        ...SCAN_ROOTS,
      ]),
    ),
    ...splitGitPathOutput(
      gitOutput([
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ...SCAN_ROOTS,
      ]),
    ),
  ];
  return candidates
    .filter((file, index, files) => files.indexOf(file) === index)
    .filter(isCandidateSourceFile)
    .map((file) => join(REPO_ROOT, file));
}

function allCandidateFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const base = join(REPO_ROOT, root);
    try {
      if (!statSync(base).isDirectory()) continue;
    } catch {
      continue;
    }
    files.push(...walk(base));
  }
  return files;
}

function listCandidateFiles(): string[] {
  if (process.env.UPDATE_PUBLIC_ROUTE_BASELINE === "1") {
    return allCandidateFiles();
  }
  const baselineFiles = baselineCandidateFiles();
  const changedFiles = changedCandidateFiles();
  const files =
    changedFiles.length > 0
      ? [...baselineFiles, ...changedFiles]
      : [...baselineFiles, ...allCandidateFiles()];
  return files.filter((file, index) => files.indexOf(file) === index);
}

let cachedPublicRoutes: PublicRouteEntry[] | undefined;

/** One `public: true` route occurrence: the source file and its HTTP path (when
 *  the declaration carries a `path:` within the same object). */
export interface PublicRouteEntry {
  /** Repo-relative POSIX path of the declaring file. */
  file: string;
  /** The route's `path:` string, or null for a non-route `public: true`. */
  path: string | null;
}

/** Stable per-occurrence id used by the baseline. */
export function publicRouteKey(entry: PublicRouteEntry): string {
  return `${entry.file}::${entry.path ?? "(no-path)"}`;
}

/** Scan the reviewed public-route ledger plus branch-changed source files. */
export function scanPublicRoutes(): PublicRouteEntry[] {
  if (cachedPublicRoutes && process.env.UPDATE_PUBLIC_ROUTE_BASELINE !== "1") {
    return cachedPublicRoutes;
  }
  const found: PublicRouteEntry[] = [];
  for (const file of listCandidateFiles()) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes("public: true")) continue;
    const lines = text.split("\n");
    const rel = relative(REPO_ROOT, file).split(sep).join("/");
    for (let i = 0; i < lines.length; i += 1) {
      if (!/\bpublic:\s*true\b/.test(lines[i])) continue;
      // The route's `path:` lives in the same object literal — look a few
      // lines either side for it.
      let path: string | null = null;
      for (let d = -6; d <= 6 && path === null; d += 1) {
        const m = lines[i + d]?.match(/\bpath:\s*["'`]([^"'`]+)["'`]/);
        if (m) path = m[1];
      }
      found.push({ file: rel, path });
    }
  }
  const sorted = found.sort((a, b) =>
    publicRouteKey(a).localeCompare(publicRouteKey(b)),
  );
  if (process.env.UPDATE_PUBLIC_ROUTE_BASELINE !== "1") {
    cachedPublicRoutes = sorted;
  }
  return sorted;
}
