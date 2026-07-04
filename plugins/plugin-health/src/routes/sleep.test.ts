/**
 * Unit test for `createHealthSleepRouteHandler` — drives the sleep history,
 * regularity, and baseline routes against a stub context with recorded responses.
 */
import { describe, expect, it, vi } from "vitest";
import { createHealthSleepRouteHandler } from "./sleep.js";

function createContext(path: string) {
  const url = new URL(`https://example.test${path}`);
  const responses: unknown[] = [];
  const errors: Array<{ message: string; status?: number }> = [];
  return {
    ctx: {
      method: "GET",
      pathname: url.pathname,
      url,
      res: {},
      json: (_res: unknown, data: unknown) => {
        responses.push(data);
      },
      error: (_res: unknown, message: string, status?: number) => {
        errors.push({ message, status });
      },
    },
    responses,
    errors,
  };
}

describe("createHealthSleepRouteHandler", () => {
  it("routes sleep history requests through the host service", async () => {
    const { ctx, responses } = createContext(
      "/api/lifeops/sleep/history?windowDays=14&includeNaps=1",
    );
    const getSleepHistory = vi.fn().mockResolvedValue({
      episodes: [],
      summary: {
        cycleCount: 0,
        averageDurationMin: null,
        overnightCount: 0,
        napCount: 0,
        openCount: 0,
      },
      windowDays: 14,
      includeNaps: true,
    });
    const handle = createHealthSleepRouteHandler({
      createService: () => ({
        getSleepHistory,
        getSleepRegularity: vi.fn(),
        getPersonalBaseline: vi.fn(),
      }),
    });

    await expect(handle(ctx)).resolves.toBe(true);

    expect(getSleepHistory).toHaveBeenCalledWith({
      windowDays: 14,
      includeNaps: true,
    });
    expect(responses).toHaveLength(1);
  });

  it("validates sleep route query parameters before calling the service", async () => {
    const { ctx, errors } = createContext(
      "/api/lifeops/sleep/regularity?windowDays=0&includeNaps=maybe",
    );
    const getSleepRegularity = vi.fn();
    const handle = createHealthSleepRouteHandler({
      createService: () => ({
        getSleepHistory: vi.fn(),
        getSleepRegularity,
        getPersonalBaseline: vi.fn(),
      }),
    });

    await expect(handle(ctx)).resolves.toBe(true);

    expect(getSleepRegularity).not.toHaveBeenCalled();
    expect(errors).toEqual([
      { message: "windowDays must be at least 1", status: 400 },
    ]);
  });

  it("ignores non-sleep routes", async () => {
    const { ctx } = createContext("/api/lifeops/inbox");
    const handle = createHealthSleepRouteHandler({
      createService: () => {
        throw new Error("should not be called");
      },
    });

    await expect(handle(ctx)).resolves.toBe(false);
  });
});
