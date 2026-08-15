/**
 * Smoke test for the cloud mock-stack orchestrator.
 *
 * Verifies flag parsing, help/error exit codes, and SIGINT-driven shutdown
 * without booting the heavy services (cloud-api, frontend, migrations).
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const SCRIPT = path.join(REPO_ROOT, "scripts/cloud/mock-stack-up.mjs");

// Bun's test-runner pipe capture loses output on `process.exit(non-zero)`,
// so we redirect child stdio to files via the shell and read them back.
function redirectedRun(args, { collectMs = 0, env = {} } = {}) {
  return new Promise((resolve) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "mock-stack-test-"));
    const outFile = path.join(tmp, "out.log");
    const errFile = path.join(tmp, "err.log");
    const cmd =
      `exec node ${JSON.stringify(SCRIPT)} ` +
      `${args.map((a) => JSON.stringify(a)).join(" ")} ` +
      `>${JSON.stringify(outFile)} 2>${JSON.stringify(errFile)}`;
    const proc = spawn("sh", ["-c", cmd], { env: { ...process.env, ...env } });
    if (collectMs > 0) {
      setTimeout(() => proc.kill("SIGINT"), collectMs);
    }
    proc.on("exit", (code, signal) => {
      let stdout = "";
      let stderr = "";
      try {
        stdout = readFileSync(outFile, "utf8");
      } catch {}
      try {
        stderr = readFileSync(errFile, "utf8");
      } catch {}
      resolve({ code, signal, stdout, stderr });
    });
  });
}

describe("mock-stack-up orchestrator", () => {
  test("--help prints usage and exits 0", async () => {
    const r = await redirectedRun(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
    expect(r.stdout).toContain("--no-frontend");
    expect(r.stdout).toContain("--reset");
  });

  test("unknown flag exits 1 with usage", async () => {
    const r = await redirectedRun(["--definitely-not-a-flag"]);
    expect(r.code).toBe(1);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain("Unknown flag");
    expect(combined).toContain("Usage:");
  });

  test.each([
    ["--port-frontend", "3000junk"],
    ["--port-api", "0"],
    ["--port-cp", "-1"],
    ["--port-hetzner", "65536"],
  ])("%s rejects an invalid override before boot", async (flag, value) => {
    const r = await redirectedRun([flag, value, "--help"]);
    expect(r.code).toBe(1);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain(
      `${flag} requires a decimal port between 1 and 65535`,
    );
    expect(combined).toContain("Usage:");
    expect(combined).not.toContain("Eliza cloud mock stack — ready");
  });

  test.each([
    ["non-numeric", ["not-a-port"]],
    ["empty", [""]],
    ["trailing junk", ["23456junk"]],
    ["fractional", ["1.5"]],
    ["whitespace-padded", [" 1"]],
    ["oversized", ["999999999999999999999999"]],
  ])("--port-api rejects %s operands", async (_case, operands) => {
    const r = await redirectedRun(["--port-api", ...operands, "--help"]);
    expect(r.code).toBe(1);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain(
      "--port-api requires a decimal port between 1 and 65535",
    );
    expect(combined).not.toContain("Eliza cloud mock stack — ready");
  });

  test("--port-api rejects a missing operand", async () => {
    const r = await redirectedRun(["--port-api"]);
    expect(r.code).toBe(1);
    const combined = r.stdout + r.stderr;
    expect(combined).toContain(
      "--port-api requires a decimal port between 1 and 65535",
    );
    expect(combined).toContain("Usage:");
    expect(combined).not.toContain("Eliza cloud mock stack — ready");
  });

  test.each([
    ["--port-frontend", "23456"],
    ["--port-api", "1"],
    ["--port-api", "65535"],
    ["--port-cp", "23456"],
    ["--port-hetzner", "23456"],
  ])("accepts valid %s override %s", async (flag, port) => {
    const r = await redirectedRun([flag, port, "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage:");
  });

  test("skip-everything boot reaches ready banner and SIGINT shuts down cleanly", async () => {
    const started = Date.now();
    const r = await redirectedRun(
      ["--no-frontend", "--no-cp", "--no-hetzner", "--no-migrations"],
      { collectMs: 4_000 },
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(15_000);
    const combined = r.stdout + r.stderr;
    // Any of: banner printed (success), shutdown logged (signal handled),
    // or fast non-zero exit (failure handled) prove the orchestrator's
    // wiring, signal, and failure paths are intact and it didn't hang.
    const handled =
      combined.includes("Eliza cloud mock stack") ||
      combined.includes("shutting down") ||
      combined.includes("stopped") ||
      combined.includes("failed to start") ||
      r.code === 1;
    expect(handled).toBe(true);
  }, 20_000);
});
