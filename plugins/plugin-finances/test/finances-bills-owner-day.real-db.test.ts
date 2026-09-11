/**
 * Proves bill due-date status is classified on the owner's calendar day, not
 * the UTC day, against a real AgentRuntime with the finances schema on PGlite.
 * A bill due "today" for an owner west of Greenwich stays `upcoming` through
 * the evening even though UTC has already rolled to the next date, and the
 * same instant is `overdue` for an owner east of the date line. Covers the
 * resolver chain: explicit argument, host-supplied resolver, the agent's
 * `TIMEZONE` setting, and the process zone. Real runtime and repository, no
 * mocks.
 */
import crypto from "node:crypto";
import type { AgentRuntime } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app-core/test/helpers/real-runtime.ts";
import { FinancesRepository } from "../src/db/finances-repository.ts";
import { FinancesService } from "../src/finances-service.ts";
import financesPlugin from "../src/plugin.ts";

// 03:30Z on March 3 is still the evening of March 2 in Los Angeles and
// Honolulu, and already March 3 in Tokyo and on UTC.
const NOW = new Date("2026-03-03T03:30:00.000Z");
const DUE_TODAY_IN_LA = "2026-03-02";

describe("upcoming bills classify due dates on the owner's calendar day", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let repository: FinancesRepository;
  let billId: string;
  const originalTz = process.env.TZ;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "finances-bills-owner-day",
      plugins: [financesPlugin],
    });
    runtime = testResult.runtime;
    repository = new FinancesRepository(runtime);
    const createdAt = "2026-02-20T12:00:00.000Z";
    const sourceId = crypto.randomUUID();
    await repository.upsertPaymentSource({
      id: sourceId,
      agentId: runtime.agentId,
      kind: "email",
      label: "Gmail bills",
      institution: null,
      accountMask: null,
      status: "active",
      lastSyncedAt: null,
      transactionCount: 0,
      metadata: {},
      createdAt,
      updatedAt: createdAt,
    });
    billId = crypto.randomUUID();
    await repository.insertPaymentTransaction({
      id: billId,
      agentId: runtime.agentId,
      sourceId,
      externalId: null,
      postedAt: createdAt,
      amountUsd: 84.5,
      direction: "debit",
      merchantRaw: "City Water",
      merchantNormalized: "city water",
      description: "March water bill",
      category: null,
      currency: "USD",
      metadata: {
        kind: "bill",
        dueDate: DUE_TODAY_IN_LA,
        confidence: 0.9,
        sourceMessageId: "msg-1",
      },
      createdAt,
    });
  }, 180_000);

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
    runtime.setSetting("TIMEZONE", null);
  });

  afterAll(async () => {
    await testResult?.cleanup();
  });

  async function statusFor(
    service: FinancesService,
    args: { timeZone?: string } = {},
  ): Promise<string> {
    const bills = await service.getUpcomingBills({ now: NOW, ...args });
    const bill = bills.find((candidate) => candidate.id === billId);
    if (!bill) throw new Error("seeded bill missing from upcoming bills");
    return bill.status;
  }

  it("uses the host-supplied owner zone before the agent setting", async () => {
    runtime.setSetting("TIMEZONE", "Asia/Tokyo");
    const service = new FinancesService(runtime, {
      resolveTimeZone: async () => "America/Los_Angeles",
    });
    expect(await statusFor(service)).toBe("upcoming");
    expect(await service.resolveCalendarTimeZone(NOW)).toBe(
      "America/Los_Angeles",
    );
  });

  it("falls back to the agent's TIMEZONE setting", async () => {
    runtime.setSetting("TIMEZONE", "Pacific/Honolulu");
    expect(await statusFor(new FinancesService(runtime))).toBe("upcoming");
    runtime.setSetting("TIMEZONE", "Asia/Tokyo");
    expect(await statusFor(new FinancesService(runtime))).toBe("overdue");
  });

  it("skips an invalid resolver result and an invalid setting", async () => {
    runtime.setSetting("TIMEZONE", "Mars/Olympus");
    process.env.TZ = "America/Los_Angeles";
    const service = new FinancesService(runtime, {
      resolveTimeZone: () => "Not/AZone",
    });
    expect(await service.resolveCalendarTimeZone(NOW)).toBe(
      "America/Los_Angeles",
    );
    expect(await statusFor(service)).toBe("upcoming");
  });

  it("honours an explicit zone argument and rejects an invalid one", async () => {
    const service = new FinancesService(runtime, {
      resolveTimeZone: () => "America/Los_Angeles",
    });
    expect(await statusFor(service, { timeZone: "Asia/Tokyo" })).toBe(
      "overdue",
    );
    await expect(
      service.getUpcomingBills({ now: NOW, timeZone: "Mars/Olympus" }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
