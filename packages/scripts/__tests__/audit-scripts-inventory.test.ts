/**
 * Smoke test for the packages/app extension of the script inventory tool
 * (issue #10200, item 2). The tool classifies the *second* dense script surface
 * (packages/app/package.json) by reachability; this locks in that the app
 * section is produced, totals are internally consistent, and the Turbo-fan-out /
 * --cwd reachability edges keep classifying the canonical app scripts.
 *
 * Outside workspace test discovery — run via
 *   bun test packages/scripts/__tests__/audit-scripts-inventory.test.ts
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildInventory } from "../audit-scripts-inventory.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

const APP_CATEGORIES = [
  "reachable-from-verify",
  "reachable-from-test",
  "reachable-from-build",
  "reachable-from-ci-workflow",
  "reachable-from-app-internal",
  "orphan",
];

function appScriptNames() {
  const pkg = JSON.parse(
    readFileSync(
      path.join(REPO_ROOT, "packages", "app", "package.json"),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };
  return Object.keys(pkg.scripts ?? {});
}

describe("script inventory: packages/app surface (issue #10200)", () => {
  const inv = buildInventory();

  test("classifies every packages/app script exactly once", () => {
    const names = appScriptNames();
    expect(inv.appScripts.map((a) => a.name).sort()).toEqual([...names].sort());
    expect(inv.summary.totalAppScripts).toBe(names.length);
  });

  test("every app script carries a known category", () => {
    for (const a of inv.appScripts) {
      expect(APP_CATEGORIES).toContain(a.category);
    }
  });

  test("category totals sum to the script count and match the per-script tally", () => {
    const byCat = inv.summary.appScriptsByCategory;
    const sum = APP_CATEGORIES.reduce((n, c) => n + byCat[c], 0);
    expect(sum).toBe(inv.summary.totalAppScripts);
    expect(byCat.orphan).toBe(inv.summary.orphanAppScripts);
  });

  test("Turbo fan-out reaches the app build/lint/typecheck scripts (not orphan)", () => {
    const cat = (name: string) =>
      inv.appScripts.find((a) => a.name === name)?.category;
    const names = new Set(appScriptNames());
    for (const task of ["build", "lint", "typecheck"]) {
      if (names.has(task)) {
        expect(cat(task), `app ${task} should be reachable`).not.toBe("orphan");
      }
    }
  });

  test("a --cwd packages/app CI-only script is reachable-from-ci-workflow", () => {
    // test:e2e is invoked across the workflows as `--cwd packages/app test:e2e`.
    const names = new Set(appScriptNames());
    if (names.has("test:e2e")) {
      const entry = inv.appScripts.find((a) => a.name === "test:e2e");
      expect(entry?.category).toBe("reachable-from-ci-workflow");
    }
  });

  test("the root/file sections are still present and unchanged in shape", () => {
    expect(Array.isArray(inv.roots)).toBe(true);
    expect(Array.isArray(inv.files)).toBe(true);
    expect(inv.summary.totalRootScripts).toBe(inv.roots.length);
  });
});
