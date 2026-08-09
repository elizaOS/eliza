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
import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildInventory,
  missingWorkflowRootScriptReferences,
  parseInventoryArgs,
  readRepositoryCandidateText,
  workflowExecutionSteps,
  workflowRootScriptReferences,
} from "../audit-scripts-inventory.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

const APP_CATEGORIES = [
  "reachable-from-verify",
  "reachable-from-test",
  "reachable-from-build",
  "reachable-from-ci-workflow",
  "reachable-from-operator-script",
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

  test("rejects misspelled and positional CLI arguments", () => {
    expect(parseInventoryArgs(["--json"])).toEqual({
      help: false,
      json: true,
    });
    expect(() => parseInventoryArgs(["--jsoon"])).toThrow(
      "unknown argument: --jsoon",
    );
    expect(() => parseInventoryArgs(["unexpected"])).toThrow(
      "unknown argument: unexpected",
    );
    expect(() => parseInventoryArgs(["--json", "--json"])).toThrow("only once");
    expect(() => parseInventoryArgs(["--help", "--json"])).toThrow(
      "cannot be combined",
    );
  });

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

  test("the root/file sections are still present and unchanged in shape", () => {
    expect(Array.isArray(inv.roots)).toBe(true);
    expect(Array.isArray(inv.files)).toBe(true);
    expect(inv.summary.totalRootScripts).toBe(inv.roots.length);
    expect(inv.scriptTests.discoveredCount).toBeGreaterThan(90);
    expect(inv.scriptTests.excluded).toEqual([
      {
        file: "packages/scripts/__tests__/release-verdaccio.integration.test.ts",
        reason:
          "the release-candidate workflow owns this slow real-registry transport test",
      },
    ]);
    expect(inv.summary.totalScriptTests).toBe(inv.scriptTests.discoveredCount);
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
      "reachable-from-verify",
    );
    expect(byFile("audit-scripts-inventory.mjs")?.category).toBe(
      "reachable-from-verify",
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

    expect(byFile("run-scenarios-isolated.mjs")?.category).toBe(
      "reachable-from-operator-script",
    );
    expect(inv.summary.filesByCategory.orphan).toBe(0);
    expect(inv.summary.orphanFiles).toBe(0);
    expect(inv.summary.documentationFileReferences).toBeGreaterThan(0);
  });

  test("repository candidate readers reject symlinked files and parents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-audit-root-"));
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), "script-audit-outside-"),
    );
    try {
      fs.mkdirSync(path.join(root, "fixtures"));
      for (const name of [
        "runner.mjs",
        "package.json",
        "guide.md",
        "workflow.yml",
      ]) {
        const source = path.join(outside, name);
        fs.writeFileSync(source, "outside\n");
        fs.symlinkSync(source, path.join(root, "fixtures", name));
        expect(() =>
          readRepositoryCandidateText(root, `fixtures/${name}`),
        ).toThrow("may not traverse a symlink");
      }
      fs.mkdirSync(path.join(outside, "nested"));
      fs.writeFileSync(path.join(outside, "nested", "guide.md"), "outside\n");
      fs.symlinkSync(path.join(outside, "nested"), path.join(root, "linked"));
      expect(() =>
        readRepositoryCandidateText(root, "linked/guide.md"),
      ).toThrow("may not traverse a symlink");
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
      fs.rmSync(outside, { force: true, recursive: true });
    }
  });

  test("workflow execution seeds come only from structural run steps", () => {
    const steps = workflowExecutionSteps(`
      jobs:
        proof:
          env:
            COMMENT_ONLY: bun run hidden:env
          steps:
            - uses: actions/checkout@v4
              with:
                note: bun run hidden:input
            # bun run hidden:comment
            - working-directory: packages/app
              run: bun run visible:command
    `);
    expect(steps).toEqual([
      {
        job: "proof",
        run: "bun run visible:command",
        workingDirectory: "packages/app",
      },
    ]);
  });

  test("workflow root-script checks cover conditionals and built-in-named scripts", () => {
    const source = `
      jobs:
        proof:
          steps:
            - run: |
                if bun run test; then
                  bun run browser-bridge:package:release
                fi
    `;
    expect(workflowRootScriptReferences(source, "proof.yml")).toEqual([
      { file: "proof.yml", job: "proof", script: "test" },
      {
        file: "proof.yml",
        job: "proof",
        script: "browser-bridge:package:release",
      },
    ]);
    expect(
      missingWorkflowRootScriptReferences([{ file: "proof.yml", source }], {
        test: "vitest",
      }),
    ).toEqual([
      {
        file: "proof.yml",
        job: "proof",
        script: "browser-bridge:package:release",
      },
    ]);
  });

  test("workflow root-script checks honor working-directory precedence", () => {
    const source = `
      defaults:
        run:
          working-directory: packages/one
      jobs:
        inherited:
          steps:
            - run: bun run package-only
        overridden:
          defaults:
            run:
              working-directory: packages/two
          steps:
            - run: bun run other-package-only
            - working-directory: .
              run: bun run root-only
    `;
    expect(workflowRootScriptReferences(source, "defaults.yml")).toEqual([
      { file: "defaults.yml", job: "overridden", script: "root-only" },
    ]);
  });

  test("workflow root-script checks follow inline cd commands", () => {
    const source = `
      jobs:
        proof:
          steps:
            - run: |
                bun run root-before
                cd packages/prompts && bun run check:secrets
    `;
    expect(workflowRootScriptReferences(source, "cd.yml")).toEqual([
      { file: "cd.yml", job: "proof", script: "root-before" },
    ]);
  });
});
