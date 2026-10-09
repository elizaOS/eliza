/**
 * Regression tests for the Mac App Store sandbox audit's Mach-O JIT scan. A
 * fake `nm` on PATH drives each outcome so the audit is exercised end to end
 * without a real packaged app.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "audit-apple-store-sandbox.ts",
);
const tempDirs: string[] = [];

function fixture(nmScript: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "mas-sandbox-audit-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const nm = path.join(bin, "nm");
  writeFileSync(nm, `#!/bin/sh\n${nmScript}\n`);
  chmodSync(nm, 0o755);
  const app = path.join(root, "Fixture.app");
  const macos = path.join(app, "Contents", "MacOS");
  mkdirSync(macos, { recursive: true });
  // 64-bit Mach-O magic followed by padding; content past the magic is unused.
  writeFileSync(
    path.join(macos, "Fixture"),
    Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 0]),
  );
  return { app, bin };
}

function runAudit({ app, bin }: { app: string; bin: string }) {
  return spawnSync(process.execPath, [scriptPath, `--app=${app}`], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("audit-apple-store-sandbox Mach-O scan", { timeout: 120_000 }, () => {
  it("fails when nm cannot read a Mach-O instead of treating it as JIT-free", () => {
    const result = runAudit(
      fixture('echo "nm: truncated or malformed object" >&2\nexit 1'),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "nm -u failed for Contents/MacOS/Fixture (exit 1)",
    );
    expect(result.stderr).toContain("truncated or malformed object");
    expect(result.stdout).not.toContain("passed");
  });

  it("fails when a non-bun Mach-O imports Apple JIT APIs", () => {
    const result = runAudit(fixture('echo "_pthread_jit_write_protect_np"'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "Contents/MacOS/Fixture imports Apple JIT APIs",
    );
  });

  it("passes when nm succeeds and reports no JIT imports", () => {
    const result = runAudit(fixture('echo "_malloc"'));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("apple-store-sandbox-audit: passed");
  });
});
