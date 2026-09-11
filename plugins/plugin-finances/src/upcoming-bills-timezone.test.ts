/**
 * Regression coverage for #31062: `FinancesService.getUpcomingBills` must judge
 * bill dueness against the owner's calendar day, not the container's UTC day.
 *
 * The harness is deterministic — it pins `now`, seeds one email bill through a
 * stubbed `FinancesRepository` (no database), and asserts the resulting status
 * across the documented zone-resolution precedence (explicit arg, injected
 * owner resolver, agent `TIMEZONE` setting, host zone) including fall-through on
 * an invalid zone value. It also exercises the `calendarDateKeyInZone` helper
 * directly so the UTC-vs-owner-day boundary is proven, not implied.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  calendarDateKeyInZone,
  FinancesService,
  type FinancesServiceOptions,
} from "./finances-service.ts";
import type {
  LifeOpsPaymentSource,
  LifeOpsPaymentTransaction,
} from "./payment-types.ts";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";

// 2026-03-03T03:30:00Z is still 2026-03-02 (evening) in the Americas but is
// already 2026-03-03 (afternoon) in Tokyo — exactly the window where a UTC-day
// comparison misclassifies a "2026-03-02" bill.
const NOW = new Date("2026-03-03T03:30:00.000Z");
const DUE_DATE = "2026-03-02";

function emailSource(): LifeOpsPaymentSource {
  return {
    id: "source-email",
    agentId: AGENT_ID,
    kind: "email",
    label: "Email bills",
    institution: null,
    accountMask: null,
    status: "active",
    lastSyncedAt: null,
    transactionCount: 1,
    metadata: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function billTransaction(): LifeOpsPaymentTransaction {
  return {
    id: "txn-bill",
    agentId: AGENT_ID,
    sourceId: "source-email",
    externalId: null,
    postedAt: "2026-02-25T00:00:00.000Z",
    amountUsd: 42.5,
    direction: "debit",
    merchantRaw: "Water Utility",
    merchantNormalized: "water utility",
    description: null,
    category: null,
    currency: "USD",
    metadata: {
      kind: "bill",
      dueDate: DUE_DATE,
      sourceMessageId: "gmail-1",
      confidence: 0.9,
    },
    createdAt: "2026-02-25T00:00:00.000Z",
  };
}

function makeService(
  settingTimeZone: string | null,
  options: FinancesServiceOptions = {},
): FinancesService {
  const runtime = {
    agentId: AGENT_ID,
    getSetting: (key: string) =>
      key === "TIMEZONE" ? settingTimeZone : undefined,
  } as unknown as IAgentRuntime;
  const service = new FinancesService(runtime, options);
  vi.spyOn(service.repository, "listPaymentSources").mockResolvedValue([
    emailSource(),
  ]);
  vi.spyOn(service.repository, "listPaymentTransactions").mockResolvedValue([
    billTransaction(),
  ]);
  return service;
}

async function statusFor(
  settingTimeZone: string | null,
  options: FinancesServiceOptions = {},
  args: { timeZone?: string } = {},
): Promise<string> {
  const service = makeService(settingTimeZone, options);
  const bills = await service.getUpcomingBills({ now: NOW, ...args });
  expect(bills).toHaveLength(1);
  return bills[0].status;
}

describe("calendarDateKeyInZone (#31062)", () => {
  it("returns the owner-zone calendar day, not the UTC day", () => {
    expect(calendarDateKeyInZone(NOW, "UTC")).toBe("2026-03-03");
    expect(calendarDateKeyInZone(NOW, "America/Los_Angeles")).toBe(
      "2026-03-02",
    );
    expect(calendarDateKeyInZone(NOW, "Pacific/Honolulu")).toBe("2026-03-02");
    expect(calendarDateKeyInZone(NOW, "Asia/Tokyo")).toBe("2026-03-03");
  });

  it("zero-pads month and day", () => {
    const jan = new Date("2026-01-05T12:00:00.000Z");
    expect(calendarDateKeyInZone(jan, "UTC")).toBe("2026-01-05");
  });

  it("throws on an unknown IANA zone so the caller can fall through", () => {
    expect(() => calendarDateKeyInZone(NOW, "Not/AZone")).toThrow();
  });
});

describe("getUpcomingBills owner-zone dueness (#31062)", () => {
  it("classifies a same-owner-day bill as upcoming via the injected owner resolver (America/Los_Angeles)", async () => {
    const status = await statusFor(null, {
      resolveTimeZone: () => "America/Los_Angeles",
    });
    expect(status).toBe("upcoming");
  });

  it("classifies as upcoming from the TIMEZONE setting when no resolver is injected (Pacific/Honolulu)", async () => {
    const status = await statusFor("Pacific/Honolulu");
    expect(status).toBe("upcoming");
  });

  it("classifies as overdue when the owner is east of Greenwich (Asia/Tokyo)", async () => {
    const status = await statusFor("Asia/Tokyo");
    expect(status).toBe("overdue");
  });

  it("prefers the injected owner resolver over the TIMEZONE setting", async () => {
    // Setting says Tokyo (would be overdue) but the owner fact says LA.
    const status = await statusFor("Asia/Tokyo", {
      resolveTimeZone: () => "America/Los_Angeles",
    });
    expect(status).toBe("upcoming");
  });

  it("falls through to the TIMEZONE setting when the injected resolver yields an invalid zone", async () => {
    const status = await statusFor("America/Los_Angeles", {
      resolveTimeZone: () => "Not/AZone",
    });
    expect(status).toBe("upcoming");
  });

  it("falls through to the next source when the resolver throws", async () => {
    const status = await statusFor("America/Los_Angeles", {
      resolveTimeZone: () => {
        throw new Error("fact store unavailable");
      },
    });
    expect(status).toBe("upcoming");
  });

  it("honors an explicit timeZone argument above every other source", async () => {
    const upcoming = await statusFor(
      "Asia/Tokyo",
      { resolveTimeZone: () => "Asia/Tokyo" },
      { timeZone: "America/Los_Angeles" },
    );
    expect(upcoming).toBe("upcoming");
    const overdue = await statusFor(
      "America/Los_Angeles",
      { resolveTimeZone: () => "America/Los_Angeles" },
      { timeZone: "Asia/Tokyo" },
    );
    expect(overdue).toBe("overdue");
  });

  it("falls through an invalid explicit argument to the injected resolver", async () => {
    const status = await statusFor(
      "Asia/Tokyo",
      { resolveTimeZone: () => "America/Los_Angeles" },
      { timeZone: "Not/AZone" },
    );
    expect(status).toBe("upcoming");
  });
});
