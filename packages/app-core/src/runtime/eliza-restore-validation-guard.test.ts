/**
 * Statically locks the app-core boot guard ahead of all process-wide app host
 * initialization; the real guard behavior is covered in the agent package.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const source = readFileSync(join(import.meta.dirname, "eliza.ts"), "utf8");

describe("app-core restore-validation guard", () => {
  test("fails before app host environment and HTTP initialization", () => {
    const start = source.indexOf("export async function startEliza(");
    const guard = source.indexOf("assertNormalRuntimeBootMode();", start);
    const environmentMutation = source.indexOf(
      'process.env.ELIZA_AGENT_ORCHESTRATOR = "1"',
      start,
    );
    const httpPatch = source.indexOf(
      "patchHttpCreateServerForCompat();",
      start,
    );

    expect(start).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(start);
    expect(guard).toBeLessThan(environmentMutation);
    expect(guard).toBeLessThan(httpPatch);
  });
});
