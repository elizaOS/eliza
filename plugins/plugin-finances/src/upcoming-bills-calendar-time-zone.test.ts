/**
 * `FinancesService.getUpcomingBills` dueness against the owner's calendar
 * day (#31062). Deterministic: `now` is pinned, one email bill is seeded
 * through a stubbed `FinancesRepository`, and the zone comes from the shared
 * calendar time zone owner registered on the fake runtime. Covers the
 * owner-zone, agent-setting and host-default sources plus the fail-closed
 * `FinancesServiceError` for an unreadable or invalid configured zone.
 */
import type { IAgentRuntime } from "@elizaos/core";
import {
  CALENDAR_TIME_ZONE_INVALID,
  CALENDAR_TIME_ZONE_UNAVAILABLE,
  type CalendarTimeZoneResolver,
  registerCalendarTimeZoneResolver,
} from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import { FinancesServiceError } from "./finance-normalize.ts";
import { FinancesService } from "./finances-service.ts";
import type {
  LifeOpsPaymentSource,
  LifeOpsPaymentTransaction,
} from "./payment-types.ts";

const AGENT_ID = "11111111-1111-1111-1111-111111111111";
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
  ownerResolver?: CalendarTimeZoneResolver,
): FinancesService {
  const runtime = {
    agentId: AGENT_ID,
    getSetting: (key: string) =>
      key === "TIMEZONE" ? settingTimeZone : undefined,
  } as unknown as IAgentRuntime;
  if (ownerResolver) registerCalendarTimeZoneResolver(runtime, ownerResolver);
  const service = new FinancesService(runtime);
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
  ownerResolver?: CalendarTimeZoneResolver,
): Promise<string> {
  const bills = await makeService(
    settingTimeZone,
    ownerResolver,
  ).getUpcomingBills({ now: NOW });
  expect(bills).toHaveLength(1);
  return bills[0].status;
}

describe("getUpcomingBills owner-day dueness (#31062)", () => {
  it("is upcoming for an owner in America/Los_Angeles (still March 2 locally)", async () => {
    expect(await statusFor(null, async () => "America/Los_Angeles")).toBe(
      "upcoming",
    );
  });

  it("is upcoming from the TIMEZONE setting when no owner zone is configured", async () => {
    expect(await statusFor("Pacific/Honolulu")).toBe("upcoming");
    expect(await statusFor("Pacific/Honolulu", async () => null)).toBe(
      "upcoming",
    );
  });

  it("is overdue for an owner east of Greenwich (Asia/Tokyo)", async () => {
    expect(await statusFor("Asia/Tokyo")).toBe("overdue");
    expect(await statusFor(null, async () => "Asia/Tokyo")).toBe("overdue");
  });

  it("prefers the owner zone over the TIMEZONE setting", async () => {
    expect(
      await statusFor("Asia/Tokyo", async () => "America/Los_Angeles"),
    ).toBe("upcoming");
  });

  it("classifies in the host zone when nothing is configured", async () => {
    const hostDay = new Intl.DateTimeFormat("en-CA", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(NOW);
    expect(await statusFor(null)).toBe(
      DUE_DATE < hostDay ? "overdue" : "upcoming",
    );
  });

  it("fails with a 503 FinancesServiceError when the owner zone cannot be read", async () => {
    const cause = new Error("fact store unavailable");
    const error = await makeService("America/Los_Angeles", async () => {
      throw cause;
    })
      .getUpcomingBills({ now: NOW })
      .catch((e) => e);
    expect(error).toBeInstanceOf(FinancesServiceError);
    expect(error).toMatchObject({
      status: 503,
      code: CALENDAR_TIME_ZONE_UNAVAILABLE,
    });
    expect(error.cause).toMatchObject({ cause });
  });

  it("fails with a 422 FinancesServiceError for an invalid configured zone", async () => {
    await expect(
      makeService(
        "America/Los_Angeles",
        async () => "Mars/Phobos",
      ).getUpcomingBills({ now: NOW }),
    ).rejects.toMatchObject({ status: 422, code: CALENDAR_TIME_ZONE_INVALID });
    await expect(
      makeService("not-a-zone").getUpcomingBills({ now: NOW }),
    ).rejects.toMatchObject({ status: 422, code: CALENDAR_TIME_ZONE_INVALID });
  });
});
