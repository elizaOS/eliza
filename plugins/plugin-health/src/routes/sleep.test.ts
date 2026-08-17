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
      "/api/lifeops/sleep/history?windowDays=14&includeNaps=true",
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

  it.each(["", undefined])(
    "accepts omitted/empty includeNaps as the default nap filter",
    async (token) => {
      const path =
        token === undefined
          ? "/api/lifeops/sleep/history?windowDays=14"
          : "/api/lifeops/sleep/history?windowDays=14&includeNaps=";
      const { ctx } = createContext(path);
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
        includeNaps: false,
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
        includeNaps: undefined,
      });
    },
  );

  it("accepts includeNaps=false as exclude-naps", async () => {
    const { ctx } = createContext(
      "/api/lifeops/sleep/history?windowDays=14&includeNaps=false",
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
      includeNaps: false,
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
      includeNaps: false,
    });
  });

  it.each(["TRUE", "1", "0", "FALSE", "yes", "no", "foo", "1e2"])(
    "rejects includeNaps=%s before getSleepHistory",
    async (token) => {
      const { ctx, errors } = createContext(
        `/api/lifeops/sleep/history?windowDays=14&includeNaps=${encodeURIComponent(token)}`,
      );
      const getSleepHistory = vi.fn();
      const handle = createHealthSleepRouteHandler({
        createService: () => ({
          getSleepHistory,
          getSleepRegularity: vi.fn(),
          getPersonalBaseline: vi.fn(),
        }),
      });
      await expect(handle(ctx)).resolves.toBe(true);
      expect(getSleepHistory).not.toHaveBeenCalled();
      expect(errors).toEqual([
        { message: "Invalid includeNaps", status: 400 },
      ]);
    },
  );

  it.each([
    "/api/lifeops/sleep/history?includeNaps=true&includeNaps=true",
    "/api/lifeops/sleep/history?includeNaps=true&includeNaps=false",
    "/api/lifeops/sleep/history?includeNaps=&includeNaps=true",
    "/api/lifeops/sleep/history?includeNaps=foo&includeNaps=true",
  ])("rejects duplicate includeNaps values in %s", async (path) => {
    const { ctx, errors } = createContext(path);
    const getSleepHistory = vi.fn();
    const handle = createHealthSleepRouteHandler({
      createService: () => ({
        getSleepHistory,
        getSleepRegularity: vi.fn(),
        getPersonalBaseline: vi.fn(),
      }),
    });
    await expect(handle(ctx)).resolves.toBe(true);
    expect(getSleepHistory).not.toHaveBeenCalled();
    expect(errors).toEqual([{ message: "Invalid includeNaps", status: 400 }]);
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
