/**
 * Public-route audit (#9948).
 *
 * Every `public: true` route bypasses the central `isAuthorized()` gate
 * (`runtime-plugin-routes.ts`: `route.public !== true && !isAuthorized()`), so a
 * new one is a new unauthenticated surface. The scanner walks the full source
 * tree so focused security tests can inspect the current inventory directly.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/agent/src/api → repo root is four levels up.
export const REPO_ROOT = join(HERE, "..", "..", "..", "..");

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

function listCandidateFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    const directory = join(REPO_ROOT, root);
    if (statSync(directory).isDirectory()) files.push(...walk(directory));
  }
  return files;
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

/** Stable per-occurrence id used by tests and reports. */
export function publicRouteKey(entry: PublicRouteEntry): string {
  return `${entry.file}::${entry.path ?? "(no-path)"}`;
}

/** Scan all production source files for public routes. */
export function scanPublicRoutes(): PublicRouteEntry[] {
  if (cachedPublicRoutes) return cachedPublicRoutes;
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
  cachedPublicRoutes = sorted;
  return sorted;
}
