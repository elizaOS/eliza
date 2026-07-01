#!/usr/bin/env node
/**
 * Self-test for lint-test-integrity.mjs. Exercises the source-neutraliser as a
 * unit and runs the analyzer against throwaway fixture trees, asserting which
 * findings it does and does not produce. Mirrors audit-scripts.self-test.mjs.
 *
 * Run: node packages/scripts/lint-test-integrity.self-test.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  analyzeTestIntegrity,
  buildAllowlist,
  neutralizeSource,
} from "./lint-test-integrity.mjs";

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  passed++;
}

/**
 * Build a fixture repo. `files` maps repo-relative paths → contents. Every path
 * must live under packages/ or plugins/ (the scan roots). A package.json with a
 * `test` script is auto-created for each `packages/<name>/` unless suppressed.
 */
function makeFixture(files, { noTestScript = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lint-test-integrity-"));
  const pkgDirs = new Set();
  for (const rel of Object.keys(files)) {
    const m = rel.match(/^(packages|plugins)\/([^/]+)\//);
    if (m) pkgDirs.add(`${m[1]}/${m[2]}`);
  }
  for (const pkgDir of pkgDirs) {
    const full = join(dir, pkgDir, "package.json");
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(
      full,
      JSON.stringify({
        name: pkgDir.replace("/", "-"),
        scripts: noTestScript ? {} : { test: "vitest run" },
      }),
    );
  }
  for (const [rel, contents] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, contents);
  }
  return dir;
}

function analyze(files, opts = {}, fixtureOpts = {}) {
  const dir = makeFixture(files, fixtureOpts);
  try {
    return analyzeTestIntegrity({
      repoRoot: dir,
      allowlistPath: null,
      ...opts,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 1. neutralizeSource — comment / string / regex neutralisation
// ---------------------------------------------------------------------------
{
  // `.only` inside a line comment is neutralised; real code is preserved.
  const src = `// left test.only here by mistake\nit.only("real", () => {});`;
  const out = neutralizeSource(src);
  assert(!/test\.only/.test(out.split("\n")[0]), "comment .only neutralised");
  assert(/it\.only\("/.test(out), "real it.only preserved");

  // `.skip` inside a string literal is neutralised.
  const s2 = `const label = "it.skip should not match";\nit("x", () => {});`;
  const o2 = neutralizeSource(s2);
  assert(!/it\.skip/.test(o2), "string-literal .skip neutralised");

  // Newline positions preserved (line numbers stay accurate).
  assert(
    neutralizeSource("a\nb\nc").split("\n").length === 3,
    "newline count preserved",
  );

  // Regex literal containing a quote does not start a phantom string: if it
  // did, the trailing `it.only(` structure would be swallowed as string body.
  const s3 = `const re = /['"]/;\nit.only("after regex", () => {});`;
  const o3 = neutralizeSource(s3);
  assert(/it\.only\(/.test(o3), "regex-literal quote handled");
}

// ---------------------------------------------------------------------------
// 2. Clean tree passes
// ---------------------------------------------------------------------------
{
  const r = analyze({
    "packages/a/x.test.ts": `it("works", () => { expect(1).toBe(1); });`,
  });
  assert(r.ok, `clean tree ok, got ${JSON.stringify(r)}`);
  assert(r.exclusives.length === 0, "clean: no exclusives");
  assert(r.orphanedSkips.length === 0, "clean: no orphaned skips");
}

// ---------------------------------------------------------------------------
// 3. Exclusive tests are blocking (no allowlist path)
// ---------------------------------------------------------------------------
{
  const r = analyze({
    "packages/a/x.test.ts": `describe.only("focus", () => { it("a", () => {}); });`,
  });
  assert(r.exclusives.length === 1, "describe.only flagged");
  assert(!r.ok, "exclusive fails the gate");

  const r2 = analyze({
    "packages/a/y.test.ts": `it.only("focus", () => {});\ntest.only("f2", () => {});`,
  });
  assert(r2.exclusives.length === 2, "it.only + test.only flagged");

  // jasmine-style fdescribe/fit flagged; a `.fit(` method call is NOT.
  const r3 = analyze({
    "packages/a/z.test.ts": `fit("focus", () => {});\nfitAddon.fit();\nconst x = obj.only(1);`,
  });
  assert(
    r3.exclusives.length === 1,
    `fit flagged once, got ${r3.exclusives.length}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Conditional / dynamic / placeholder skips are NOT orphaned
// ---------------------------------------------------------------------------
{
  // Conditional: first arg is not a string literal.
  const r1 = analyze({
    "packages/a/c.test.ts": `test.skip(!HAS_KEY, "needs key");\nit("runs", () => {});`,
  });
  assert(r1.orphanedSkips.length === 0, "conditional skip not orphaned");
  assert(
    r1.placeholderSkips.length === 0,
    "conditional skip is not a placeholder either",
  );

  // Dynamic: single string arg, no callback.
  const r2 = analyze({
    "packages/a/d.test.ts": `test.skip("provider key unavailable");`,
  });
  assert(r2.orphanedSkips.length === 0, "dynamic skip not orphaned");
  assert(r2.placeholderSkips.length === 1, "dynamic skip is a placeholder");

  // Empty-body placeholder (the [live] gate idiom).
  const r3 = analyze({
    "packages/a/e.test.ts": "it.skip(`[live] suite skipped`, () => {});",
  });
  assert(r3.orphanedSkips.length === 0, "empty-body skip not orphaned");
  assert(r3.placeholderSkips.length === 1, "empty-body skip is a placeholder");
}

// ---------------------------------------------------------------------------
// 5. Non-empty declared skip is orphaned (blocking)
// ---------------------------------------------------------------------------
{
  const r = analyze({
    "packages/a/f.test.ts": `it.skip("real disabled test", () => {\n  expect(compute()).toBe(42);\n});`,
  });
  assert(r.orphanedSkips.length === 1, "non-empty declared skip orphaned");
  assert(!r.ok, "orphaned skip fails the gate");
  assert(
    r.orphanedSkips[0].line === 1,
    "orphaned skip reports the declaration line",
  );
}

// ---------------------------------------------------------------------------
// 6. Tracking reference exempts a declared skip
// ---------------------------------------------------------------------------
{
  // Adjacent comment with #NNN.
  const r1 = analyze({
    "packages/a/g.test.ts": `// disabled pending #4242\nit.skip("blocked", () => {\n  expect(x).toBe(1);\n});`,
  });
  assert(r1.orphanedSkips.length === 0, "adjacent #NNN exempts");
  assert(r1.trackedSkips.length === 1, "adjacent #NNN counts as tracked");

  // Reference inside the title string.
  const r2 = analyze({
    "packages/a/h.test.ts": `it.skip("blocked by ELIZA-99 infra", () => {\n  expect(x).toBe(1);\n});`,
  });
  assert(r2.trackedSkips.length === 1, "ELIZA-NN in title exempts");

  // A bare 2-digit number is not a tracking ref.
  const r3 = analyze({
    "packages/a/i.test.ts": `it.skip("30 minute cooldown window", () => {\n  expect(x).toBe(1);\n});`,
  });
  assert(r3.orphanedSkips.length === 1, "short number is not a tracking ref");
}

// ---------------------------------------------------------------------------
// 7. Allowlist suppresses + ratchets (unused capacity errors)
// ---------------------------------------------------------------------------
{
  const files = {
    "packages/a/j.test.ts": `it.skip("dupe", () => { doA(); });\nit.skip("dupe", () => { doB(); });`,
  };
  const dir = makeFixture(files);
  try {
    // Seed a matching allowlist via buildAllowlist, then re-run with it.
    const seed = analyzeTestIntegrity({ repoRoot: dir, allowlistPath: null });
    assert(seed.orphanedSkips.length === 2, "two dupes orphaned pre-allowlist");
    const allowlist = buildAllowlist(seed);
    assert(allowlist.entries.length === 1, "dupes collapse to one entry");
    assert(allowlist.entries[0].count === 2, "entry count captures both dupes");

    const allowlistFile = join(dir, "al.json");
    writeFileSync(allowlistFile, JSON.stringify(allowlist));
    const suppressed = analyzeTestIntegrity({
      repoRoot: dir,
      allowlistPath: allowlistFile,
    });
    assert(suppressed.orphanedSkips.length === 0, "allowlist suppresses both");
    assert(
      suppressed.suppressedSkips.length === 2,
      "both counted as suppressed",
    );
    assert(suppressed.ok, "allowlisted tree passes");

    // Over-provisioned allowlist (count too high) → ratchet error.
    const over = { entries: [{ ...allowlist.entries[0], count: 3 }] };
    const overFile = join(dir, "over.json");
    writeFileSync(overFile, JSON.stringify(over));
    const overRun = analyzeTestIntegrity({
      repoRoot: dir,
      allowlistPath: overFile,
    });
    assert(overRun.allowlistErrors.length === 1, "unused capacity errors");
    assert(!overRun.ok, "unused capacity fails the gate");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 8. Never-run inventory (informational, never blocking)
// ---------------------------------------------------------------------------
{
  const r = analyze({
    "packages/a/thing.real.test.ts": `it("live", () => { expect(1).toBe(1); });`,
  });
  assert(
    r.neverRunFiles.some((f) => /real/.test(f.reason)),
    "*.real.test flagged never-run",
  );
  assert(r.ok, "never-run alone does not fail the gate");

  const r2 = analyze(
    { "packages/b/orphan.test.ts": `it("x", () => {});` },
    {},
    { noTestScript: true },
  );
  assert(
    r2.neverRunFiles.some((f) => /no ancestor/.test(f.reason)),
    "package without test script flagged never-run",
  );
  assert(r2.ok, "no-test-script inventory does not fail the gate");

  // A scriptless nested src/package.json is NOT flagged when a parent package
  // runs the tests (`cd src && vitest run`) — the false positive this heuristic
  // must avoid.
  const r3 = analyze({
    "packages/c/package.json": JSON.stringify({
      name: "c",
      scripts: { test: "cd src && vitest run" },
    }),
    "packages/c/src/package.json": JSON.stringify({ name: "c-src" }),
    "packages/c/src/x.test.ts": `it("x", () => { expect(1).toBe(1); });`,
  });
  assert(
    !r3.neverRunFiles.some((f) => f.file.endsWith("packages/c/src/x.test.ts")),
    "nested scriptless src/ package not flagged when parent runs tests",
  );
}

console.log(`[lint-test-integrity.self-test] PASS ${passed} assertions`);
