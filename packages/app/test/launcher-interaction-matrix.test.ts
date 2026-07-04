import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Launcher interaction-matrix gate (#12378, #12179 WI-9, vitest, boot-free).
 *
 * Parses the checked-in packages/app/docs/LAUNCHER_INTERACTION_MATRIX.md and
 * proves it stays honest: every spec/source path the matrix cites exists on
 * disk, and every launcher gesture-handler source site is mapped by the doc. The
 * matrix is per-platform coverage prose; a reader trusts it only if a renamed or
 * deleted spec, or a new launcher gesture handler with no row, fails CI here
 * rather than rotting silently. Sibling to chat-gesture-coverage.test.ts and
 * launcher-view-coverage.test.ts — file reads + set diffs, no renderer boot.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const UI_SRC = path.join(REPO_ROOT, "packages/ui/src");
const MATRIX_DOC = path.join(
  REPO_ROOT,
  "packages/app/docs/LAUNCHER_INTERACTION_MATRIX.md",
);

function readMatrix(): string {
  return readFileSync(MATRIX_DOC, "utf8");
}

/**
 * Every inline-code repo-relative path the doc cites that names a real
 * spec/source/runner file (`.ts` / `.tsx` / `.mjs` / `.swift`). `N/A` cells and
 * prose carry no such token, so the extracted set is exactly the citations that
 * must resolve on disk.
 */
function citedFilePaths(doc: string): string[] {
  const found = new Set<string>();
  const inlineCode = /`([^`]+)`/g;
  for (const [, token] of doc.matchAll(inlineCode)) {
    if (/^packages\/[^`\s]+\.(ts|tsx|mjs|swift)$/.test(token)) {
      found.add(token);
    }
  }
  return [...found].sort();
}

/**
 * A launcher gesture-handler site is a non-test `packages/ui/src` file that
 * defines or consumes the rail pager engine — the gesture system behind every
 * home↔launcher interaction. A new consumer of the hook is a new launcher
 * gesture surface and must earn a matrix row.
 */
const LAUNCHER_GESTURE_MARKERS: readonly RegExp[] = [/\buseHorizontalPager\b/];

function isSiteCandidate(fileName: string): boolean {
  if (!/\.(ts|tsx)$/.test(fileName)) return false;
  if (/\.test\.(ts|tsx)$/.test(fileName)) return false;
  if (/\.stories\.(ts|tsx)$/.test(fileName)) return false;
  return true;
}

function discoverLauncherGestureSites(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        if (
          entry === "node_modules" ||
          entry === "__e2e__" ||
          entry === "testing"
        )
          continue;
        walk(abs);
        continue;
      }
      if (!isSiteCandidate(entry)) continue;
      const source = readFileSync(abs, "utf8");
      if (LAUNCHER_GESTURE_MARKERS.some((marker) => marker.test(source))) {
        found.push(path.relative(REPO_ROOT, abs));
      }
    }
  };
  walk(UI_SRC);
  return found.sort();
}

/**
 * The launcher gesture-handler roster the matrix must map. Pinned so a broken
 * discovery predicate (which would empty the set and make coverage trivially
 * pass) is caught, and so an intentional add/remove is a visible edit here +
 * in the doc. Update this and LAUNCHER_INTERACTION_MATRIX.md together.
 */
const PINNED_LAUNCHER_GESTURE_SITES: readonly string[] = [
  "packages/ui/src/components/shell/HomeLauncherSurface.tsx",
  "packages/ui/src/hooks/useHorizontalPager.ts",
];

describe("launcher interaction matrix gate", () => {
  it("the matrix doc is checked in", () => {
    expect(
      existsSync(MATRIX_DOC),
      "packages/app/docs/LAUNCHER_INTERACTION_MATRIX.md is missing.",
    ).toBe(true);
  });

  it("every spec/source path the matrix cites exists on disk", () => {
    const cited = citedFilePaths(readMatrix());
    // A doc that cited nothing would pass this vacuously; pin a floor.
    expect(
      cited.length,
      "The matrix cites no spec files — the doc or the extractor is broken.",
    ).toBeGreaterThanOrEqual(15);

    const missing = cited.filter(
      (rel) => !existsSync(path.resolve(REPO_ROOT, rel)),
    );
    expect(
      missing,
      `Matrix cites path(s) that do not exist on disk: ${missing.join(", ")}. Fix the path or add the missing spec.`,
    ).toEqual([]);
  });

  it("covers a stable, non-empty roster of launcher gesture-handler sites", () => {
    expect(discoverLauncherGestureSites()).toEqual([
      ...PINNED_LAUNCHER_GESTURE_SITES,
    ]);
  });

  it("every launcher gesture-handler site is mapped by the matrix", () => {
    const doc = readMatrix();
    const unmapped = discoverLauncherGestureSites().filter(
      (site) => !doc.includes(site),
    );
    expect(
      unmapped,
      [
        `Launcher gesture-handler site(s) with no matrix mention: ${unmapped.join(", ")}.`,
        "Add each to packages/app/docs/LAUNCHER_INTERACTION_MATRIX.md — a new",
        "launcher gesture must ship its per-platform coverage row.",
      ].join(" "),
    ).toEqual([]);
  });

  it("the matrix references no renamed/removed launcher gesture site", () => {
    const discovered = new Set(discoverLauncherGestureSites());
    const stale = PINNED_LAUNCHER_GESTURE_SITES.filter(
      (site) => !discovered.has(site),
    );
    expect(
      stale,
      `Pinned launcher gesture site(s) no longer discovered (renamed/deleted): ${stale.join(", ")}. Update the pin + the doc.`,
    ).toEqual([]);
  });
});
