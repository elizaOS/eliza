/**
 * Exercises LifeOps persona catalog reporting and error translation without
 * pinning pack identities, authored totals, or verification counts.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(
  import.meta.dirname,
  "../check-lifeops-persona-catalog-coverage.mjs",
);

function runCoverage(...args: string[]) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
  });
}

describe("LifeOps persona catalog report", () => {
  test("emits a valid JSON report for the current catalogs", () => {
    const result = runCoverage("--json");
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const report = JSON.parse(result.stdout) as {
      packs: Array<{
        file: string;
        pack: string;
        authored: number;
        verified: number;
        unverifiedRows: unknown[];
      }>;
      target: number;
      authored: number;
      verified: number;
      errors: string[];
    };
    expect(report.errors).toEqual([]);
    expect(typeof report.target).toBe("number");
    expect(typeof report.authored).toBe("number");
    expect(typeof report.verified).toBe("number");
    for (const pack of report.packs) {
      expect(pack.file).toMatch(/\.catalog\.json$/);
      expect(typeof pack.pack).toBe("string");
      expect(typeof pack.authored).toBe("number");
      expect(typeof pack.verified).toBe("number");
      expect(Array.isArray(pack.unverifiedRows)).toBe(true);
    }
  });

  test("renders summary and unverified report modes", () => {
    const summary = runCoverage();
    expect(summary.status).toBe(0);
    expect(summary.stdout).toContain(
      "LifeOps persona scenario catalog coverage",
    );
    expect(summary.stdout).toContain("Total:");

    const unverified = runCoverage("--unverified");
    expect(unverified.status).toBe(0);
    expect(unverified.stdout).toContain(
      "LifeOps persona scenario unverified rows",
    );
    expect(unverified.stdout).toContain("Total:");
  });

  test("rejects an unknown pack filter explicitly", () => {
    const result = runCoverage("--pack", "__DOES_NOT_EXIST__", "--json");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "did not match a known LifeOps persona pack",
    );
  });

  test("--require-verified fails a pack with an unverified authored row", () => {
    const catalogDir = join(
      import.meta.dirname,
      "../../../plugins/plugin-personal-assistant/test/scenarios/_catalogs",
    );
    const tampered = mkdtempSync(join(tmpdir(), "lifeops-catalogs-"));
    cpSync(catalogDir, tampered, { recursive: true });
    const fr1File = join(tampered, "first-run-onboarding.catalog.json");
    const fr1 = JSON.parse(readFileSync(fr1File, "utf8"));
    fr1.scenarios[0].status = "authored";
    writeFileSync(fr1File, JSON.stringify(fr1));

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--pack", "FR1", "--require-verified"],
      {
        encoding: "utf8",
        env: { ...process.env, LIFEOPS_CATALOG_DIR: tampered },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--require-verified requires every authored row to be verified",
    );
  });

  test("L1 and FR1 pass --require-verified with structured row evidence", () => {
    for (const pack of ["L1", "FR1"]) {
      const result = runCoverage("--pack", pack, "--require-verified");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
  });

  test("strict-evidence packs reject a verified row whose evidence receipt is missing", () => {
    const catalogDir = join(
      import.meta.dirname,
      "../../../plugins/plugin-personal-assistant/test/scenarios/_catalogs",
    );
    const tampered = mkdtempSync(join(tmpdir(), "lifeops-catalogs-"));
    cpSync(catalogDir, tampered, { recursive: true });
    const fr1File = join(tampered, "first-run-onboarding.catalog.json");
    const fr1 = JSON.parse(readFileSync(fr1File, "utf8"));
    delete fr1.scenarios[0].evidence;
    writeFileSync(fr1File, JSON.stringify(fr1));

    const result = spawnSync(
      process.execPath,
      [scriptPath, "--pack", "FR1", "--require-verified"],
      {
        encoding: "utf8",
        env: { ...process.env, LIFEOPS_CATALOG_DIR: tampered },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "verified rows in pack FR1 must carry an evidence object",
    );
  });
});
