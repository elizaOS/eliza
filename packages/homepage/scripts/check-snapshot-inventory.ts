#!/usr/bin/env bun
/**
 * Gate that keeps the committed visual-regression baselines exactly equal to
 * the route x viewport matrix in `tests/e2e/visual-routes.ts`.
 *
 * A missing baseline means `toHaveScreenshot` would silently write and pass on
 * its first CI run instead of diffing; a stray one means a route was renamed or
 * dropped and left dead pixels behind. The homepage smoke job runs this before
 * Playwright so either drift is reported as a file-anchored annotation rather
 * than as a confusing screenshot failure.
 *
 * The inventory is read through `git ls-files`, not the working tree: baselines
 * a contributor regenerated for their own platform are untracked local
 * artifacts and must not be judged against the Linux matrix CI arbitrates.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { expectedSnapshotNames } from "../tests/e2e/visual-routes";

const PACKAGE_ROOT = path.resolve(import.meta.dirname, "..");

export const SNAPSHOT_DIR = path.resolve(
  PACKAGE_ROOT,
  "tests/e2e/visual.spec.ts-snapshots",
);

export interface SnapshotInventoryProblem {
  kind: "missing" | "unexpected";
  name: string;
  /** Package-relative path, for the `::error file=` annotation. */
  file: string;
}

/**
 * Baseline filenames git tracks under `directory`. Throws when git cannot
 * resolve the path — an empty inventory is never a healthy result here.
 */
export function listTrackedBaselineNames(
  directory: string = SNAPSHOT_DIR,
): string[] {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--error-unmatch", "--", `${directory}/*.png`],
    { cwd: PACKAGE_ROOT, encoding: "utf8" },
  );
  return output
    .split("\0")
    .filter((entry) => entry.length > 0)
    .map((entry) => path.posix.basename(entry))
    .sort();
}

/** Compares an inventory of baseline filenames against the derived matrix. */
export function findSnapshotInventoryProblems(
  names: Iterable<string>,
): SnapshotInventoryProblem[] {
  const expected = expectedSnapshotNames();
  const present = new Set(names);
  const annotate = (
    kind: SnapshotInventoryProblem["kind"],
    name: string,
  ): SnapshotInventoryProblem => ({
    kind,
    name,
    file: `tests/e2e/visual.spec.ts-snapshots/${name}`,
  });

  const problems: SnapshotInventoryProblem[] = [];
  for (const name of expected) {
    if (!present.has(name)) {
      problems.push(annotate("missing", name));
    }
  }
  for (const name of [...present].sort()) {
    if (!expected.includes(name)) {
      problems.push(annotate("unexpected", name));
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = findSnapshotInventoryProblems(listTrackedBaselineNames());
  for (const problem of problems) {
    const detail =
      problem.kind === "missing"
        ? "Missing required homepage snapshot baseline; regenerate on Linux with scripts/regenerate-baselines.sh and commit the PNG"
        : "Unexpected homepage snapshot baseline; it matches no route x viewport in tests/e2e/visual-routes.ts";
    console.error(`::error file=${problem.file}::${detail}`);
  }
  if (problems.length > 0) {
    process.exit(1);
  }
  console.log(
    `Validated ${expectedSnapshotNames().length} exact homepage snapshot baselines.`,
  );
}
