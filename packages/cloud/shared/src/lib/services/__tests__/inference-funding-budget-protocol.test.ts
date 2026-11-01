/**
 * Canonical-order contract for budget consumption receipts.
 *
 * budgetConsumptionPayload() output is HMAC-signed by one service and
 * verified by others, and its SHA-256 digest is stored on the receipt.
 * The allocation order inside the payload must be code-unit order on
 * every host: with localeCompare, a Danish host orders the grantId
 * "aa…" after "b0…" (aa collates as å), so one logical consumption
 * produced a payload its verifier rejected. These tests pin the exact
 * payload bytes and verify a signature made by a Node process whose
 * default locale is da-DK.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  budgetConsumptionPayload,
  budgetRequestDigest,
  verifyBudgetEffect,
} from "../inference-funding-budget-protocol";

const SECRET = "test-secret-test-secret-0123456789abcdef";
const AA = { grantId: "aa000000-0000-4000-8000-000000000001", sequence: 1, amountMicros: "100" };
const B0 = { grantId: "b0000000-0000-4000-8000-000000000002", sequence: 2, amountMicros: "200" };

function consumption(allocations: (typeof AA)[]) {
  return {
    organizationId: "org-1",
    requestId: "req-1",
    amountMicros: "300",
    allocations,
    metadata: {},
  };
}

const EXPECTED_PAYLOAD =
  '["inference-funding-budget-consume-v1","org-1","req-1","300",' +
  '[{"amountMicros":"100","grantId":"aa000000-0000-4000-8000-000000000001","sequence":1},' +
  '{"amountMicros":"200","grantId":"b0000000-0000-4000-8000-000000000002","sequence":2}],{}]';

describe("budgetConsumptionPayload", () => {
  test("lists allocations in code-unit order for either input order", async () => {
    const forward = budgetConsumptionPayload(consumption([AA, B0]));
    const reversed = budgetConsumptionPayload(consumption([B0, AA]));
    expect(forward).toBe(EXPECTED_PAYLOAD);
    expect(reversed).toBe(EXPECTED_PAYLOAD);
    expect(await budgetRequestDigest(forward)).toBe(await budgetRequestDigest(reversed));
  });

  test("a signature made under a da-DK host locale verifies", async () => {
    if (spawnSync("node", ["--version"]).error) return; // node is the full-icu host stand-in
    const dir = mkdtempSync(join(tmpdir(), "budget-protocol-"));
    try {
      const built = await Bun.build({
        entrypoints: [join(import.meta.dir, "../inference-funding-budget-protocol.ts")],
        outdir: dir,
        target: "node",
        format: "esm",
      });
      if (!built.success) throw new Error("bundle failed");
      const signer = join(dir, "sign.mjs");
      writeFileSync(
        signer,
        `import { budgetConsumptionPayload, signBudgetEffect } from ${JSON.stringify(
          pathToFileURL(built.outputs[0].path).href,
        )};\n` +
          `const unsigned = ${JSON.stringify(consumption([B0, AA]))};\n` +
          `const payload = budgetConsumptionPayload(unsigned);\n` +
          `console.log(JSON.stringify({ payload, signature: await signBudgetEffect(payload, ${JSON.stringify(SECRET)}) }));\n`,
      );
      const run = spawnSync("node", [signer], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "da_DK.UTF-8" },
      });
      if (run.error) return;
      expect(run.status).toBe(0);
      const foreign = JSON.parse(run.stdout.trim()) as { payload: string; signature: string };
      expect(foreign.payload).toBe(EXPECTED_PAYLOAD);
      expect(await verifyBudgetEffect(foreign.payload, foreign.signature, SECRET)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
