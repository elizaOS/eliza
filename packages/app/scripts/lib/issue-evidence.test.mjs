// #13624: the capture skip contract must not swallow a missing artifact when
// evidence was explicitly requested. resolveRequireEvidence() decides whether a
// run must PRODUCE evidence (explicit flag > env > auto-on under CI), and skip()
// turns a "no device / wrong OS / tool missing" case into a NON-ZERO failure
// when evidence was required (instead of exiting 0 green with zero artifacts).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { resolveRequireEvidence } from "./issue-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("resolveRequireEvidence (#13624)", () => {
  it("defaults to false for a local ad-hoc run (no flag, no env, no CI)", () => {
    expect(resolveRequireEvidence([], {})).toBe(false);
  });

  it("is true with a bare --require-evidence flag", () => {
    expect(resolveRequireEvidence(["--require-evidence"], {})).toBe(true);
  });

  it("honors --require-evidence <value> (space form)", () => {
    expect(resolveRequireEvidence(["--require-evidence", "true"], {})).toBe(
      true,
    );
    expect(resolveRequireEvidence(["--require-evidence", "false"], {})).toBe(
      false,
    );
    expect(resolveRequireEvidence(["--require-evidence", "0"], {})).toBe(false);
    expect(resolveRequireEvidence(["--require-evidence", "off"], {})).toBe(
      false,
    );
  });

  it("honors --require-evidence=<value> (equals form)", () => {
    expect(resolveRequireEvidence(["--require-evidence=1"], {})).toBe(true);
    expect(resolveRequireEvidence(["--require-evidence=no"], {})).toBe(false);
  });

  it("a bare --require-evidence followed by another flag is a true opt-in", () => {
    // `--require-evidence --issue 13624` — the next token is a flag, not a value.
    expect(
      resolveRequireEvidence(["--require-evidence", "--issue", "13624"], {}),
    ).toBe(true);
  });

  it("--no-require-evidence is an explicit opt-out that beats CI", () => {
    expect(
      resolveRequireEvidence(["--no-require-evidence"], { CI: "true" }),
    ).toBe(false);
  });

  it("an explicit --require-evidence false beats a truthy CI env", () => {
    expect(
      resolveRequireEvidence(["--require-evidence", "false"], { CI: "true" }),
    ).toBe(false);
  });

  it("last flag occurrence wins (explicit off after on)", () => {
    expect(
      resolveRequireEvidence(
        ["--require-evidence", "--no-require-evidence"],
        {},
      ),
    ).toBe(false);
    expect(
      resolveRequireEvidence(
        ["--no-require-evidence", "--require-evidence"],
        {},
      ),
    ).toBe(true);
  });

  it("auto-on under CI=true / CI=1", () => {
    expect(resolveRequireEvidence([], { CI: "true" })).toBe(true);
    expect(resolveRequireEvidence([], { CI: "1" })).toBe(true);
  });

  it("does NOT arm on falsey CI spellings (0/false/off/empty)", () => {
    for (const v of ["0", "false", "off", "no", "", "  "]) {
      expect(resolveRequireEvidence([], { CI: v })).toBe(false);
    }
  });

  it("env opt-in E2E_REQUIRE_EVIDENCE / ELIZA_REQUIRE_EVIDENCE", () => {
    expect(resolveRequireEvidence([], { E2E_REQUIRE_EVIDENCE: "1" })).toBe(
      true,
    );
    expect(resolveRequireEvidence([], { ELIZA_REQUIRE_EVIDENCE: "yes" })).toBe(
      true,
    );
    expect(resolveRequireEvidence([], { E2E_REQUIRE_EVIDENCE: "0" })).toBe(
      false,
    );
  });

  it("REGRESSION: an explicit --require-evidence must not silently degrade to a soft skip", () => {
    // The whole point of #13624: if the caller demanded evidence, resolve must
    // report true so skip() exits non-zero. If this ever reverts to ignoring
    // argv, this assertion fails.
    expect(resolveRequireEvidence(["--require-evidence"], {})).not.toBe(false);
  });
});

// skip() exits the process, so it must be exercised in a subprocess. A tiny
// harness module (written to a real temp file so process.argv has the normal
// [node, script, ...argv] shape — `node -e` drops argv[1]) imports the real
// module and calls skip() with the argv/env under test. Start from a clean env
// so the ambient host CI var can't leak into a case that expects a soft skip;
// then layer only the vars the case declares.
const harnessFiles = [];
afterAll(() => {
  for (const f of harnessFiles) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function runSkip({ argv = [], env = {} } = {}) {
  const modulePath = JSON.stringify(path.join(here, "issue-evidence.mjs"));
  const harness = `import { skip } from ${modulePath}; skip('ios-sim', 'no booted simulator');`;
  const harnessPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "issue-evidence-skip-")),
    "harness.mjs",
  );
  fs.writeFileSync(harnessPath, harness, "utf8");
  harnessFiles.push(harnessPath);
  return spawnSync(process.execPath, [harnessPath, ...argv], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, ...env },
  });
}

describe("skip() exit contract (#13624)", () => {
  it("exits 0 with a [skip] line when evidence is NOT required (local default)", () => {
    const res = runSkip({ argv: [], env: {} });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("[capture:ios-sim] [skip]");
    expect(res.stdout).toContain("no booted simulator");
  });

  it("exits NON-ZERO with a [require-evidence] line under --require-evidence", () => {
    const res = runSkip({ argv: ["--require-evidence"], env: {} });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("[capture:ios-sim] [require-evidence]");
    expect(res.stderr).toContain("evidence was required but not captured");
  });

  it("exits NON-ZERO under CI=true (auto-on) even without the flag", () => {
    const res = runSkip({ argv: [], env: { CI: "true" } });
    expect(res.status).not.toBe(0);
    expect(res.stderr).toContain("[require-evidence]");
  });

  it("stays a soft skip (exit 0) with an explicit --no-require-evidence even under CI", () => {
    const res = runSkip({
      argv: ["--no-require-evidence"],
      env: { CI: "true" },
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("[skip]");
  });
});
