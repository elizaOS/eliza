/**
 * Tests for app analytics getAppUsageSummary division and NaN bounds.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { AppAnalyticsService } from "./app-analytics";

const findByIdMock = mock(async (_appId: string) => app());

function service(): AppAnalyticsService {
  return new AppAnalyticsService({ findById: findByIdMock } as never);
}

function app(totalCreditsUsed: string | null = "15.00") {
  return {
    total_requests: 300,
    total_users: 12,
    total_credits_used: totalCreditsUsed,
  };
}

beforeEach(() => {
  findByIdMock.mockReset();
});

describe("app-analytics usage calculation bounds", () => {
  test("computes standard averages correctly", () => {
    findByIdMock.mockResolvedValue(app());

    const res = service().getAppUsageSummary("app-1", 30);

    return expect(res).resolves.toMatchObject({
      totalCost: "15.00",
      avgRequestsPerDay: 10,
      avgCostPerDay: "0.50",
    });
  });

  test("rejects invalid days before querying the repository", async () => {
    for (const days of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      await expect(service().getAppUsageSummary("app-1", days)).rejects.toMatchObject({
        code: "INVALID_APP_USAGE_SUMMARY_DAYS",
      });
    }
    expect(findByIdMock).not.toHaveBeenCalled();
  });

  test("fails fast for malformed stored credits", async () => {
    for (const credits of ["invalid-credits", "12.50junk", "NaN", "Infinity", ""]) {
      findByIdMock.mockResolvedValue(app(credits));

      await expect(service().getAppUsageSummary("app-1", 10)).rejects.toMatchObject({
        code: "INVALID_APP_USAGE_TOTAL_CREDITS",
      });
    }
  });

  test("preserves the schema-established zero for a legacy null credit total", async () => {
    findByIdMock.mockResolvedValue(app(null));

    await expect(service().getAppUsageSummary("app-1", 10)).resolves.toMatchObject({
      totalCost: "0.00",
      avgCostPerDay: "0.00",
    });
  });
});
