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
 *
 * The ordering change moved the tag to v2: v1 bytes used localeCompare.
 * Receipts recorded under v1 keep signatures and digests over the legacy
 * bytes (see budgetConsumptionLegacyPayload), and the replay paths accept
 * them; the da-DK subprocess below pins those legacy bytes too.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  budgetConsumptionLegacyPayload,
  budgetConsumptionPayload,
  budgetRequestDigest,
  verifyBudgetEffect,
} from "../inference-funding-budget-protocol";

const SECRET = "x".repeat(32);
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
  '["inference-funding-budget-consume-v2","org-1","req-1","300",' +
  '[{"amountMicros":"100","grantId":"aa000000-0000-4000-8000-000000000001","sequence":1},' +
  '{"amountMicros":"200","grantId":"b0000000-0000-4000-8000-000000000002","sequence":2}],{}]';

// The v1 bytes of the same consumption on a da-DK host: localeCompare
// orders "aa…" as å, after "b0…", so the allocation array flips.
const EXPECTED_LEGACY_PAYLOAD_DA =
  '["inference-funding-budget-consume-v1","org-1","req-1","300",' +
  '[{"amountMicros":"200","grantId":"b0000000-0000-4000-8000-000000000002","sequence":2},' +
  '{"amountMicros":"100","grantId":"aa000000-0000-4000-8000-000000000001","sequence":1}],{}]';

describe("budgetConsumptionPayload", () => {
  test("lists allocations in code-unit order for either input order", async () => {
    const forward = budgetConsumptionPayload(consumption([AA, B0]));
    const reversed = budgetConsumptionPayload(consumption([B0, AA]));
    expect(forward).toBe(EXPECTED_PAYLOAD);
    expect(reversed).toBe(EXPECTED_PAYLOAD);
    expect(await budgetRequestDigest(forward)).toBe(await budgetRequestDigest(reversed));
  });

  test("the legacy payload keeps the v1 tag", () => {
    expect(budgetConsumptionLegacyPayload(consumption([AA, B0]))).toContain(
      '"inference-funding-budget-consume-v1"',
    );
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
        `import { budgetConsumptionLegacyPayload, budgetConsumptionPayload, budgetRequestDigest, signBudgetEffect } from ${JSON.stringify(
          pathToFileURL(built.outputs[0].path).href,
        )};\n` +
          `const unsigned = ${JSON.stringify(consumption([B0, AA]))};\n` +
          `const payload = budgetConsumptionPayload(unsigned);\n` +
          `const legacyPayload = budgetConsumptionLegacyPayload(unsigned);\n` +
          `console.log(JSON.stringify({ payload, signature: await signBudgetEffect(payload, ${JSON.stringify(SECRET)}), legacyPayload, legacyDigest: await budgetRequestDigest(legacyPayload) }));\n`,
      );
      const run = spawnSync("node", [signer], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "da_DK.UTF-8" },
      });
      if (run.error) return;
      expect(run.status).toBe(0);
      const foreign = JSON.parse(run.stdout.trim()) as {
        payload: string;
        signature: string;
        legacyPayload: string;
        legacyDigest: string;
      };
      expect(foreign.payload).toBe(EXPECTED_PAYLOAD);
      expect(await verifyBudgetEffect(foreign.payload, foreign.signature, SECRET)).toBe(true);
      // On the same da-DK host the v1 bytes flip the allocation order, so a
      // receipt recorded there carries a different digest for this
      // consumption; the legacy builder must reproduce those bytes exactly.
      expect(foreign.legacyPayload).toBe(EXPECTED_LEGACY_PAYLOAD_DA);
      expect(foreign.legacyDigest).not.toBe(await budgetRequestDigest(foreign.payload));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
