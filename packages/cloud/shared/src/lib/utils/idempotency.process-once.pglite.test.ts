/**
 * Proves `processOnce` runs webhook work exactly once for overlapping
 * redeliveries and releases the claim when the work fails, against the real
 * idempotency table on PGlite (#31768).
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";

process.env.DATABASE_URL = "pglite://memory";
process.env.NODE_ENV ||= "test";
setDefaultTimeout(120_000);

import { closeDatabaseConnectionsForTests, getPgliteClientForTests } from "../../db/client";
import { processOnce, tryClaimForProcessing } from "./idempotency";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  await getPgliteClientForTests().exec(`
    CREATE TABLE idempotency_keys (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      source text NOT NULL,
      created_at timestamp NOT NULL DEFAULT now(),
      expires_at timestamp NOT NULL
    );
  `);
});

afterAll(async () => {
  await closeDatabaseConnectionsForTests();
});

describe("processOnce", () => {
  test("overlapping redeliveries of one key run the work once", async () => {
    let handled = 0;
    const work = async () => {
      handled += 1;
      await delay(50);
      return "reply";
    };
    const outcomes = await Promise.all([
      processOnce("twilio:SM_overlap", "twilio", work),
      processOnce("twilio:SM_overlap", "twilio", work),
    ]);
    expect(handled).toBe(1);
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["duplicate", "processed"]);
    // A later redelivery inside the TTL is still refused.
    expect(await processOnce("twilio:SM_overlap", "twilio", work)).toEqual({ status: "duplicate" });
    expect(handled).toBe(1);
  });

  test("a failing work function releases the claim and rethrows", async () => {
    await expect(
      processOnce("blooio:MSG_fail", "blooio", async () => {
        throw new Error("gateway down");
      }),
    ).rejects.toThrow("gateway down");
    expect(await tryClaimForProcessing("blooio:MSG_fail", "blooio")).toBe(true);
  });
});
