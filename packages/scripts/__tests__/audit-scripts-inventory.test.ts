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

const FILE_CATEGORIES = [
  "reachable-from-verify",
  "reachable-from-test",
  "reachable-from-build",
  "reachable-from-ci-workflow",
  "reachable-from-operator-script",
  "reachable-from-package-script",
  "reachable-from-docs",
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

  test("package-local script callers keep helper files out of the orphan bucket", () => {
    for (const f of inv.files) {
      expect(FILE_CATEGORIES).toContain(f.category);
    }

    const darwinWrapper = inv.files.find(
      (f) => f.file === "run-bash-darwin-only.mjs",
    );
    expect(darwinWrapper?.category).toBe("reachable-from-package-script");
    expect(darwinWrapper?.packageScriptCallers).toContainEqual({
      packageJson: "packages/native/ios-deps/package.json",
      script: "build:llama-cpp",
    });
    expect(
      inv.summary.filesByCategory["reachable-from-package-script"],
    ).toBeGreaterThan(0);
    expect(inv.summary.packageScriptFileReferences).toBeGreaterThan(0);
  });

  test("named root operator scripts keep their entrypoint files out of the orphan bucket", () => {
    const byFile = (name: string) => inv.files.find((f) => f.file === name);
    const byRoot = (name: string) => inv.roots.find((r) => r.name === name);

    expect(byRoot("dev:all")?.category).toBe("reachable-from-operator-script");
    expect(byFile("dev-all.mjs")?.category).toBe(
      "reachable-from-operator-script",
    );
    expect(byFile("dev-all.mjs")?.operatorScriptCallers).toContainEqual({
      packageJson: "package.json",
      script: "dev:all",
    });
    expect(byRoot("audit:scripts:inventory")?.category).toBe(
      "reachable-from-operator-script",
    );
    expect(byFile("audit-scripts-inventory.mjs")?.category).toBe(
      "reachable-from-operator-script",
    );
    expect(
      byFile("audit-scripts-inventory.mjs")?.operatorScriptCallers,
    ).toContainEqual({
      packageJson: "package.json",
      script: "audit:scripts:inventory",
    });
    expect(
      inv.summary.filesByCategory["reachable-from-operator-script"],
    ).toBeGreaterThan(0);
    expect(inv.summary.operatorScriptFileReferences).toBeGreaterThan(0);
  });

  test("documented standalone scripts are tracked separately from true orphans", () => {
    const byFile = (name: string) => inv.files.find((f) => f.file === name);

    expect(byFile("ensure-skills.mjs")?.category).toBe("reachable-from-docs");
    expect(byFile("run-scenarios-isolated.mjs")?.category).toBe(
      "reachable-from-docs",
    );
    expect(byFile("validate-tee-local-stack.mjs")?.category).toBe(
      "reachable-from-docs",
    );
    expect(inv.summary.filesByCategory.orphan).toBe(0);
    expect(inv.summary.orphanFiles).toBe(0);
    expect(inv.summary.documentationFileReferences).toBeGreaterThan(0);
  });
});
