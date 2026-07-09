/**
 * Gate for the guarded `*.real.test.ts` / `*.live.test.ts` accounting
 * (#9310 §E). The post-merge lane (run-all-tests.mjs, TEST_LANE=post-merge)
 * prints a loud, named skip summary for every guarded suite instead of a
 * silent green nothing; this test keeps that accounting honest:
 *
 *   1. the manifest matches the on-disk guarded set exactly (no drift);
 *   2. every declared guard env var is really read by the suite (or a
 *      declared guardVia helper) — no phantom credentials;
 *   3. package vitest configs agree with the manifest: a non-blocked suite
 *      is never unconditionally excluded (it must run — and self-skip loudly
 *      — in the post-merge lane), and a `blocked` claim matches a real
 *      unconditional exclude;
 *   4. the accounting classification + summary formatting behave (precedence,
 *      anyOf groups, the missing-creds line printed even at zero).
 *
 * packages/scripts/__tests__ is outside workspace test discovery — this file
 * runs via an explicit `bun test` leg in .github/workflows/scenario-pr.yml.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  computeRealLiveAccounting,
  diffRealLiveManifest,
  discoverGuardedRealLiveFiles,
  formatRealLiveSummaryLines,
  GUARDED_REAL_LIVE_SUITES,
} from "../lib/real-live-suites.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");

interface ManifestEntry {
  file: string;
  requires?: string[];
  anyOf?: string[][];
  optIn?: string;
  guardVia?: string[];
  probe?: string;
  blocked?: string;
  notes?: string;
}

const manifest = GUARDED_REAL_LIVE_SUITES as ManifestEntry[];

function suiteKind(file: string): "real" | "live" {
  return /\.real\.test\.tsx?$/.test(file) ? "real" : "live";
}

/** Nearest ancestor dir of `file` (repo-relative) containing a package.json. */
function owningPackageDir(file: string): string {
  let dir = path.dirname(path.join(repoRoot, file));
  while (dir.length > repoRoot.length) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return repoRoot;
}

describe("real/live guarded-suite manifest (#9310 §E)", () => {
  test("discovery ignores nested agent worktree directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "real-live-discovery-"));
    try {
      const realSuite = path.join(
        root,
        "packages",
        "core",
        "live.real.test.ts",
      );
      const nestedCodexSuite = path.join(
        root,
        ".codex-worktrees",
        "branch",
        "packages",
        "core",
        "duplicate.real.test.ts",
      );
      const nestedCodexPrSuite = path.join(
        root,
        ".codex-pr-worktrees",
        "pr-1",
        "packages",
        "core",
        "duplicate.live.test.ts",
      );
      for (const file of [realSuite, nestedCodexSuite, nestedCodexPrSuite]) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "describe.skip('guarded', () => {});\n");
      }

      expect(discoverGuardedRealLiveFiles(root)).toEqual([
        "packages/core/live.real.test.ts",
      ]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("manifest matches the on-disk guarded set (no drift)", () => {
    const drift = diffRealLiveManifest(discoverGuardedRealLiveFiles(repoRoot));
    expect(
      drift.unlisted,
      "guarded on disk but missing from GUARDED_REAL_LIVE_SUITES — add an entry (with its cred/opt-in/probe guard) to packages/scripts/lib/real-live-suites.mjs",
    ).toEqual([]);
    expect(
      drift.stale,
      "listed in GUARDED_REAL_LIVE_SUITES but no longer guarded on disk — remove the stale entry",
    ).toEqual([]);
  });

  test("every declared guard env var is read by the suite or its guardVia helpers", () => {
    const problems: string[] = [];
    for (const entry of manifest) {
      const sources = [entry.file, ...(entry.guardVia ?? [])]
        .map((rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8"))
        .join("\n");
      const declared = [
        ...(entry.requires ?? []),
        ...(entry.anyOf ?? []).flat(),
        ...(entry.optIn ? [entry.optIn] : []),
      ];
      for (const name of declared) {
        if (!sources.includes(name)) {
          problems.push(
            `${entry.file}: manifest declares ${name} but neither the suite nor its guardVia helpers mention it`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  test("package vitest configs agree with the manifest blocked/invocable split", () => {
    const problems: string[] = [];
    for (const entry of manifest) {
      const pkgDir = owningPackageDir(entry.file);
      const configPath = path.join(pkgDir, "vitest.config.ts");
      if (!fs.existsSync(configPath)) {
        if (entry.blocked) {
          problems.push(
            `${entry.file}: marked blocked but ${path.relative(repoRoot, pkgDir)} has no vitest.config.ts to exclude it`,
          );
        }
        continue; // vitest defaults include *.test.ts — invocable.
      }
      const config = fs.readFileSync(configPath, "utf8");
      // The exclude-glob spelling for this suite kind, e.g. "*.real.test."
      // matches "**/*.real.test.{ts,tsx}" / "**/*.real.test.*" /
      // "src/**/*.real.test.ts" but NOT "*.real.e2e.test.*".
      const kindGlob = `*.${suiteKind(entry.file)}.test.`;
      const excludesKind = config.includes(kindGlob);
      const laneConditional =
        config.includes('VITEST_LANE === "post-merge"') ||
        config.includes('VITEST_LANE !== "post-merge"') ||
        config.includes("VITEST_EXCLUDE_REAL");
      if (entry.blocked) {
        if (!excludesKind) {
          problems.push(
            `${entry.file}: marked blocked but ${path.relative(repoRoot, configPath)} has no "${kindGlob}" exclude — update the manifest (the suite may be invocable now)`,
          );
        }
      } else if (excludesKind && !laneConditional) {
        problems.push(
          `${entry.file}: ${path.relative(repoRoot, configPath)} unconditionally excludes "${kindGlob}" — either make the exclude lane-conditional (VITEST_LANE === "post-merge") so the suite runs in the post-merge sweep, or mark the manifest entry blocked with a reason`,
        );
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("real/live accounting classification", () => {
  const synthetic: ManifestEntry[] = [
    { file: "a.real.test.ts", requires: ["KEY_A"] },
    { file: "b.live.test.ts", optIn: "GATE_B", requires: ["KEY_B"] },
    { file: "c.live.test.ts", anyOf: [["K1"], ["K2", "K3"]] },
    { file: "d.real.test.ts", probe: "attached display" },
    {
      file: "e.real.test.ts",
      blocked: "excluded in every lane",
      requires: ["KEY_E"],
    },
    { file: "f.real.test.ts" },
  ];

  test("keyless env: named missing-creds skips, opt-in and blocked take precedence", () => {
    const accounting = computeRealLiveAccounting({}, synthetic);
    expect(accounting.missingCreds).toEqual([
      { file: "a.real.test.ts", missing: ["KEY_A"] },
      { file: "c.live.test.ts", missing: ["one of K1 | K2+K3"] },
    ]);
    expect(accounting.optIn).toEqual([
      { file: "b.live.test.ts", gate: "GATE_B" },
    ]);
    expect(accounting.probed).toEqual([
      { file: "d.real.test.ts", probe: "attached display" },
    ]);
    expect(accounting.blocked).toEqual([
      { file: "e.real.test.ts", reason: "excluded in every lane" },
    ]);
    expect(accounting.armed.map((item) => item.file)).toEqual([
      "f.real.test.ts",
    ]);
  });

  test("creds satisfied: requires, anyOf group, and opt-in gate arm their suites", () => {
    const accounting = computeRealLiveAccounting(
      { KEY_A: "x", GATE_B: "1", KEY_B: "y", K2: "a", K3: "b" },
      synthetic,
    );
    expect(accounting.armed.map((item) => item.file)).toEqual([
      "a.real.test.ts",
      "b.live.test.ts",
      "c.live.test.ts",
      "f.real.test.ts",
    ]);
    expect(accounting.missingCreds).toEqual([]);
    // blocked always wins, even with the cred present.
    const blocked = computeRealLiveAccounting({ KEY_E: "x" }, synthetic);
    expect(blocked.blocked.map((item) => item.file)).toEqual([
      "e.real.test.ts",
    ]);
  });

  test("whitespace-only creds and non-'1' opt-in values do not arm a suite", () => {
    const accounting = computeRealLiveAccounting(
      { KEY_A: "  ", GATE_B: "true" },
      synthetic,
    );
    expect(accounting.missingCreds.map((item) => item.file)).toContain(
      "a.real.test.ts",
    );
    expect(accounting.optIn.map((item) => item.file)).toContain(
      "b.live.test.ts",
    );
  });

  test("summary always includes the missing-creds line, even at zero", () => {
    const clean = formatRealLiveSummaryLines(
      computeRealLiveAccounting({ KEY_A: "x" }, [
        { file: "a.real.test.ts", requires: ["KEY_A"] },
      ]),
    );
    expect(
      clean.some((line) =>
        line.includes("0 real suites skipped for missing creds: none"),
      ),
    ).toBe(true);

    const missing = formatRealLiveSummaryLines(
      computeRealLiveAccounting({}, [
        { file: "a.real.test.ts", requires: ["KEY_A"] },
      ]),
    );
    const missingLine = missing.find((line) =>
      line.includes("1 real suites skipped for missing creds"),
    );
    expect(missingLine).toContain("a.real.test.ts (missing KEY_A)");
  });
});
