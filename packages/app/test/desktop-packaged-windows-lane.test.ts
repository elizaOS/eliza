/**
 * Guards the `test:desktop:packaged:windows` packaged-Windows smoke lane wiring
 * (elizaOS/eliza#13682).
 *
 * Regression: three call sites invoked `bun run test:desktop:packaged:windows`
 * but no package.json defined it, so the lane died with `error: Script not
 * found` — an invisible break (every release-electrobun run since 2026-06-20
 * concluded `skipped`). These tests assert the canonical lane is defined at the
 * root (where all three call sites run it) and in packages/app, the three call
 * sites reference the exact same name, the macOS lane stays distinct (no rename
 * collapse), and the preflight runner fails NON-ZERO with a truthful message on
 * a non-Windows host instead of the old "Script not found" or a silent green
 * skip.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "..", "..");

const CANONICAL_LANE = "test:desktop:packaged:windows";

function readJson(relFromRepo: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, relFromRepo), "utf8"),
  ) as Record<string, unknown>;
}

function readText(relFromRepo: string): string {
  return fs.readFileSync(path.join(repoRoot, relFromRepo), "utf8");
}

function readScripts(relFromRepo: string): Record<string, string> {
  const pkg = readJson(relFromRepo);
  return (pkg.scripts ?? {}) as Record<string, string>;
}

function readSuites(): Record<string, { command?: string }> {
  const matrix = readJson("packages/app-core/test/regression-matrix.json") as {
    suites?: Record<string, { command?: string }>;
  };
  return matrix.suites ?? {};
}

// Under `bun test`, `process.execPath` points at the bun binary, which routes
// an `.mjs` child's stdio differently and can drop captured output. Resolve a
// real node binary from PATH so the child's precondition message is captured
// deterministically regardless of the outer test runner.
function resolveNodeBinary(): string {
  const isWin = process.platform === "win32";
  const names = isWin ? ["node.exe", "node"] : ["node"];
  const pathValue = process.env.PATH ?? process.env.Path ?? "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  // Fall back to execPath only if node is not on PATH (best effort).
  return process.execPath;
}

describe("test:desktop:packaged:windows lane wiring (#13682)", () => {
  it("defines the canonical lane in packages/app/package.json", () => {
    const scripts = readScripts("packages/app/package.json");
    expect(scripts[CANONICAL_LANE]).toBeTruthy();
    // Delegates to the dedicated preflight runner (not a raw playwright call
    // that would green-skip on non-win32 or bypass the Windows smoke contract).
    expect(scripts[CANONICAL_LANE]).toContain(
      "run-desktop-packaged-windows.mjs",
    );
  });

  it("is invokable from the repo root where all three call sites run it", () => {
    // The release workflow step, release-check.ts, and regression-matrix.json
    // all execute `bun run test:desktop:packaged:windows` from the repository
    // root (no working-directory / --cwd). A root delegator must exist or Bun
    // fails with `error: Script not found` from root even though the app-level
    // lane is defined (elizaOS/eliza#13682 P1).
    const rootScripts = readScripts("package.json");
    expect(rootScripts[CANONICAL_LANE]).toBeTruthy();
    expect(rootScripts[CANONICAL_LANE]).toContain(
      `--cwd packages/app ${CANONICAL_LANE}`,
    );
  });

  it("ships the preflight runner script the lane points at", () => {
    const runner = path.join(
      appDir,
      "scripts",
      "run-desktop-packaged-windows.mjs",
    );
    expect(fs.existsSync(runner)).toBe(true);
  });

  it("preserves the release workflow launcher-path handoff contract", () => {
    const runner = readText(
      "packages/app/scripts/run-desktop-packaged-windows.mjs",
    );
    expect(runner).toContain("smoke-test-windows.ps1");
    expect(runner).toContain("pwsh");
    expect(
      readText(
        "packages/app-core/platforms/electrobun/scripts/smoke-test-windows.ps1",
      ),
    ).toContain("ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE");
    expect(readText(".github/workflows/release-electrobun.yml")).toContain(
      "ELIZA_TEST_WINDOWS_LAUNCHER_PATH_FILE",
    );
  });

  it("all three call sites reference the exact canonical lane name", () => {
    // release-electrobun.yml — the Smoke test packaged Windows app step.
    expect(readText(".github/workflows/release-electrobun.yml")).toContain(
      `bun run ${CANONICAL_LANE}`,
    );
    // release-check.ts required-snippet list.
    expect(readText("packages/app-core/scripts/release-check.ts")).toContain(
      `bun run ${CANONICAL_LANE}`,
    );
    // regression-matrix.json desktop-packaged-windows suite.
    expect(readSuites()["desktop-packaged-windows"]?.command).toBe(
      `bun run ${CANONICAL_LANE}`,
    );
  });

  it("distinct named lane from the macOS packaged lane (no rename collapse)", () => {
    const suites = readSuites();
    expect(suites["desktop-packaged-macos"]?.command).toBe(
      "bun run test:desktop:packaged",
    );
    expect(suites["desktop-packaged-windows"]?.command).toBe(
      `bun run ${CANONICAL_LANE}`,
    );
    expect(suites["desktop-packaged-windows"]?.command).not.toBe(
      suites["desktop-packaged-macos"]?.command,
    );
  });

  it("fails NON-ZERO with a truthful precondition message on a non-Windows host", () => {
    if (process.platform === "win32") {
      // On a real Windows runner this delegates into Playwright and can only be
      // exercised with a packaged build present; the non-win32 branch is what
      // guards the "Script not found" -> truthful-precondition regression.
      return;
    }
    const runner = path.join(
      appDir,
      "scripts",
      "run-desktop-packaged-windows.mjs",
    );
    const result = spawnSync(resolveNodeBinary(), [runner], {
      cwd: appDir,
      encoding: "utf8",
    });
    // Non-zero exit (NOT "Script not found", NOT a green 0 skip).
    expect(result.status).not.toBe(0);
    expect(result.status).toBeGreaterThan(0);
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(combined).toContain("requires a windows host");
    expect(combined).toContain(process.platform);
    expect(combined).not.toContain("Script not found");
  });
});
