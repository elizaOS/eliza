/**
 * Proves `processOnce` runs webhook work exactly once for overlapping
 * redeliveries and releases the claim when the work fails, against the real
 * idempotency table on PGlite (#31768). The check-then-mark control shows the
 * race the helper closes.
 */
process.env.DATABASE_URL = "pglite://memory";
process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pushSchema } from "drizzle-kit/api";
import { closeDatabaseConnectionsForTests, dbWrite } from "../../db/client";
import { idempotencyKeys } from "../../db/schemas/idempotency-keys";
import {
  isAlreadyProcessed,
  markAsProcessed,
  processOnce,
  tryClaimForProcessing,
} from "./idempotency";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  const { apply } = await pushSchema({ idempotencyKeys } as never, dbWrite as never);
  await apply();
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

  test("control: check-then-mark processes both overlapping deliveries", async () => {
    let handled = 0;
    const checkThenMark = async () => {
      if (await isAlreadyProcessed("twilio:SM_control")) return "duplicate";
      handled += 1;
      await delay(50);
      await markAsProcessed("twilio:SM_control", "twilio");
      return "processed";
    };
    const results = await Promise.all([checkThenMark(), checkThenMark()]);
    expect(results).toEqual(["processed", "processed"]);
    expect(handled).toBe(2);
  });
});
