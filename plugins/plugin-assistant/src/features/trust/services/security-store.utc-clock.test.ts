/**
 * The behavioral-profile store touches `updated_at` two ways: an INSERT leaves
 * the value to the column default, an UPDATE passes a JS `Date`. Both writes
 * must land on the same clock, or a row created a second ago reads hours away
 * from a row updated a second ago whenever the database session is not UTC.
 */

import type { UUID } from "@elizaos/core";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../../../../packages/app/test/helpers/real-runtime.ts";
import { createTrustPlugin } from "../index.ts";
import type { DrizzleDB } from "./db.ts";
import {
  getBehavioralProfile,
  upsertBehavioralProfile,
} from "./SecurityStore.ts";

let testResult: RealTestRuntimeResult;
let db: DrizzleDB;

beforeAll(async () => {
  testResult = await createRealTestRuntime({
    characterName: "trust-store-utc-clock-tests",
    plugins: [createTrustPlugin()],
  });
  db = testResult.runtime.db as unknown as DrizzleDB;
}, 180_000);

afterAll(async () => {
  await testResult?.cleanup();
});

describe("behavioral profile updated_at", () => {
  it("keeps the insert default and the update value on one clock", async () => {
    const entityId = crypto.randomUUID() as UUID;
    await db.execute(sql`set time zone 'Asia/Shanghai'`);
    try {
      await upsertBehavioralProfile(db, { entityId, typingSpeed: 40 });
      const inserted = await getBehavioralProfile(db, entityId);
      if (!inserted) throw new Error("behavioral profile insert did not land");
      const insertedAt = (inserted.updatedAt as Date).getTime();
      expect(Math.abs(insertedAt - Date.now())).toBeLessThan(60_000);

      await upsertBehavioralProfile(db, { entityId, typingSpeed: 41 });
      const updated = await getBehavioralProfile(db, entityId);
      if (!updated) throw new Error("behavioral profile update did not land");
      const updatedAt = (updated.updatedAt as Date).getTime();
      expect(updatedAt - insertedAt).toBeGreaterThanOrEqual(0);
      expect(updatedAt - insertedAt).toBeLessThan(60_000);
    } finally {
      await db.execute(sql`reset time zone`);
    }
  });
});
