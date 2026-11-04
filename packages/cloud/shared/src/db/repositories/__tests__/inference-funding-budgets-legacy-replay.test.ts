/**
 * Replay compatibility for receipts recorded under the v1 payload.
 *
 * budgetConsumptionPayload moved to a v2 tag with code-unit allocation
 * order. A consumption recorded before that change, on a host whose
 * collation is not code-unit order, stored the digest of the v1
 * (localeCompare) bytes; retrying it must return { replayed: true },
 * not fail with "replay changes its receipt". This test bundles the
 * real repository scenario and runs it in a Node process whose default
 * locale is da-DK, where the v1 and v2 byte sets actually differ.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const SECRET = "x".repeat(32);

describe("recordConsumption legacy replay", () => {
  test("a v1-recorded receipt replays under either signature, a foreign digest still fails", async () => {
    if (spawnSync("node", ["--version"]).error) return; // node is the full-icu host stand-in
    // The bundle must live under the package so Node resolves the
    // external native dependencies from the workspace node_modules.
    const dir = mkdtempSync(join(import.meta.dir, "../../../..", ".tmp-legacy-replay-"));
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "inference-funding-budgets-legacy-replay.scenario.ts")],
        outdir: dir,
        target: "node",
        format: "esm",
        conditions: ["eliza-source"],
        external: ["cpu-features", "ssh2"],
      });
      if (!built.success) throw new Error("bundle failed");
      const run = spawnSync("node", [built.outputs[0].path], {
        encoding: "utf8",
        env: {
          ...process.env,
          LC_ALL: "da_DK.UTF-8",
          DATABASE_URL: "pglite://memory",
          TEST_DATABASE_URL: "pglite://memory",
          ENVIRONMENT: "local",
          MOCK_REDIS: "1",
          INFERENCE_FUNDING_BUDGET_SEAL_SECRET: SECRET,
        },
      });
      if (run.error) return;
      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as {
        legacySigned?: { replayed?: boolean };
        currentSigned?: { replayed?: boolean };
        mismatch?: { error?: string };
      };
      expect(outcome.legacySigned).toEqual({ replayed: true });
      expect(outcome.currentSigned).toEqual({ replayed: true });
      expect(outcome.mismatch?.error).toContain("Budget consumption replay changes its receipt");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
