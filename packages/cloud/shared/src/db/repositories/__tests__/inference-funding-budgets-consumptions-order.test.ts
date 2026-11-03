/**
 * Canonical-order contract for budget consumption rows.
 *
 * recordConsumption() inserts one consumptions row per allocation.
 * The rows must be inserted in code-unit grant order on every host:
 * the grants are locked in Postgres id order in the same transaction,
 * so a host-locale insert order (Danish collation orders the grantId
 * "aa…" after "b0…") makes the multi-row insert take its locks in a
 * different order than the grant locks. This test bundles the real
 * repository scenario and runs it in a Node process whose default
 * locale is da-DK, then reads the rows back in insertion order.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const SECRET = "x".repeat(32);
const AA = "aa000000-0000-4000-8000-000000000001";
const B0 = "b0000000-0000-4000-8000-000000000002";

describe("recordConsumption", () => {
  test("inserts consumptions rows in code-unit grant order on a da-DK host", async () => {
    if (spawnSync("node", ["--version"]).error) return; // node is the full-icu host stand-in
    // The bundle must live under the package so Node resolves the
    // external native dependencies from the workspace node_modules.
    const dir = mkdtempSync(join(import.meta.dir, "../../../..", ".tmp-consumptions-order-"));
    try {
      const built = await Bun.build({
        entrypoints: [
          join(import.meta.dir, "inference-funding-budgets-consumptions-order.scenario.ts"),
        ],
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
      const inserted = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "[]") as string[];
      expect(inserted).toEqual([AA, B0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
