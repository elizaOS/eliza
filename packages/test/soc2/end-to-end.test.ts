/**
 * SOC2 end-to-end verification integration spec.
 *
 * Runs the full check matrix against the real workspace. Asserts the harness
 * itself works (produces a report, the dynamic crypto checks pass) without
 * gating on the static checks — those depend on parallel agent landings and
 * are tracked by the report itself.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  hasCriticalFailures,
  runVerification,
  writeReport,
} from "../../soc2-verify/src/index.js";

const elizaRoot = resolve(__dirname, "../../..");
const outerRoot = resolve(elizaRoot, "..");

let tmpDir: string;

describe("SOC2 verification harness — full run", () => {
  it("produces a complete evidence report", async () => {
    const report = await runVerification({ elizaRoot, outerRoot });
    expect(typeof report.commit).toBe("string");
    expect(report.overall.pass + report.overall.fail).toBeGreaterThan(0);

    tmpDir = resolve(elizaRoot, ".soc2-evidence/integration-run");
    const { jsonPath, mdPath } = writeReport(report, { outDir: tmpDir });
    expect(existsSync(jsonPath)).toBe(true);
    expect(existsSync(mdPath)).toBe(true);

    const parsed = JSON.parse(readFileSync(jsonPath, "utf8"));
    expect(parsed.generated_at).toBe(report.generated_at);
  }, 120_000);

  it("dynamic crypto + audit checks pass regardless of repo state", async () => {
    const report = await runVerification({
      elizaRoot,
      outerRoot,
      include: ["roundtrip", "audit-dispatcher", "redaction"],
    });
    // Every dynamic check in the include set must pass.
    for (const block of Object.values(report.controls)) {
      for (const c of block.checks) {
        expect(
          { id: c.id, status: c.status, evidence: c.evidence },
        ).toMatchObject({ status: "pass" });
      }
    }
  });

  it("hasCriticalFailures is a boolean", async () => {
    const report = await runVerification({ elizaRoot, outerRoot });
    expect(typeof hasCriticalFailures(report)).toBe("boolean");
  });

  afterAll(() => {
    // tmpDir is left in place for inspection.
    if (tmpDir && !existsSync(tmpDir)) {
      // nothing to do — the writer would have created it
    }
  });
});
