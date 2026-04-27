/**
 * End-to-end verification of the real `eliza/apps/app-counter` workspace
 * through AppVerificationService.
 *
 * Proves the full pipeline works against a non-fixture, real, in-tree app:
 *   - typecheck passes
 *   - lint passes (or noop)
 *   - the app's own vitest suite passes
 *   - the verdict aggregates to "pass"
 *
 * Skip cleanly if no package manager (bun / pnpm / npm) is on PATH so this
 * can run in any sandbox.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { AppVerificationService } from "../app-verification.js";

const execFileAsync = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
// services/__tests__/ → typescript → plugin-app-control → plugins → eliza
const COUNTER_WORKDIR = path.resolve(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "apps",
  "app-counter",
);

async function packageManagerAvailable(): Promise<boolean> {
  for (const pm of ["bun", "pnpm", "npm"]) {
    try {
      await execFileAsync(pm, ["--version"], { timeout: 5_000 });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

const skip =
  !(await packageManagerAvailable()) || !existsSync(COUNTER_WORKDIR);

describe.skipIf(skip)("AppVerificationService — real app-counter workspace", () => {
  const service = new AppVerificationService();

  afterAll(async () => {
    await service.cleanup?.();
  });

  it("verdict=pass under profile=fast", async () => {
    const result = await service.verifyApp({
      workdir: COUNTER_WORKDIR,
      appName: "app-counter",
      profile: "fast",
      runId: "counter-e2e-fast",
    });
    if (result.verdict !== "pass") {
      const summary = result.checks
        .map((c) => `  - ${c.kind}: ${c.passed ? "pass" : "FAIL"} (${c.durationMs}ms)`)
        .join("\n");
      throw new Error(
        `verifyApp returned verdict=fail.\nChecks:\n${summary}\n\nRetryable prompt:\n${result.retryablePromptForChild}`,
      );
    }
    expect(result.verdict).toBe("pass");
    expect(result.checks.length).toBeGreaterThan(0);
    const typecheck = result.checks.find((c) => c.kind === "typecheck");
    const lint = result.checks.find((c) => c.kind === "lint");
    expect(typecheck?.passed).toBe(true);
    expect(lint?.passed).toBe(true);
  }, 120_000);

  it("the counter app's own vitest suite is part of the pipeline", async () => {
    const result = await service.verifyApp({
      workdir: COUNTER_WORKDIR,
      appName: "app-counter",
      checks: [{ kind: "typecheck" }, { kind: "lint" }, { kind: "test" }],
      runId: "counter-e2e-test-only",
    });
    if (result.verdict !== "pass") {
      const summary = result.checks
        .map((c) => `  - ${c.kind}: ${c.passed ? "pass" : "FAIL"} (${c.durationMs}ms)`)
        .join("\n");
      throw new Error(
        `verifyApp returned verdict=fail with test included.\nChecks:\n${summary}\n\nRetryable prompt:\n${result.retryablePromptForChild}`,
      );
    }
    expect(result.verdict).toBe("pass");
    const test = result.checks.find((c) => c.kind === "test");
    expect(test?.passed).toBe(true);
  }, 240_000);
});
