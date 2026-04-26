import type http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LifeOpsService } from "../lifeops/service.js";
import { handleSleepRoutes } from "./sleep-routes.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const runtime = {
  agentId: "00000000-0000-0000-0000-000000000000",
} as LifeOpsRouteContext["state"]["runtime"];

function createContext(
  path: string,
  overrides: Partial<LifeOpsRouteContext> = {},
): {
  context: LifeOpsRouteContext;
  error: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
} {
  const url = new URL(path, "http://localhost");
  const json = vi.fn();
  const error = vi.fn();
  const context: LifeOpsRouteContext = {
    req: {
      url: `${url.pathname}${url.search}`,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    res: {
      writeHead: vi.fn(),
      end: vi.fn(),
    } as unknown as http.ServerResponse,
    method: "GET",
    pathname: url.pathname,
    url,
    state: {
      runtime,
      adminEntityId: null,
    },
    json,
    error,
    readJsonBody: vi.fn(async () => ({})),
    decodePathComponent: (raw) => decodeURIComponent(raw),
    ...overrides,
  };

  return { context, error, json };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleSleepRoutes", () => {
  it("passes a full-year history window through to the service", async () => {
    const getSleepHistory = vi
      .spyOn(LifeOpsService.prototype, "getSleepHistory")
      .mockResolvedValue({
        episodes: [],
        includeNaps: false,
        windowDays: 365,
      });
    const { context, error, json } = createContext(
      "/api/lifeops/sleep/history?windowDays=365&includeNaps=false",
    );

    await expect(handleSleepRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getSleepHistory).toHaveBeenCalledWith({
      includeNaps: false,
      windowDays: 365,
    });
    expect(json).toHaveBeenCalledWith(context.res, {
      episodes: [],
      includeNaps: false,
      windowDays: 365,
    });
  });

  it("passes regularity query options through to the service", async () => {
    const getSleepRegularity = vi
      .spyOn(LifeOpsService.prototype, "getSleepRegularity")
      .mockResolvedValue({
        bedtimeStddevMin: 0,
        classification: "stable",
        midSleepStddevMin: 0,
        sampleSize: 0,
        sri: 1,
        wakeStddevMin: 0,
        windowDays: 30,
      });
    const { context, error, json } = createContext(
      "/api/lifeops/sleep/regularity?windowDays=30&includeNaps=true",
    );

    await expect(handleSleepRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getSleepRegularity).toHaveBeenCalledWith({
      includeNaps: true,
      windowDays: 30,
    });
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({ sampleSize: 0, windowDays: 30 }),
    );
  });

  it("passes baseline window options through to the service", async () => {
    const getPersonalBaseline = vi
      .spyOn(LifeOpsService.prototype, "getPersonalBaseline")
      .mockResolvedValue({
        bedtimeStddevMin: null,
        medianBedtimeLocalHour: null,
        medianSleepDurationMin: null,
        medianWakeLocalHour: null,
        sampleSize: 0,
        wakeStddevMin: null,
        windowDays: 365,
      });
    const { context, error, json } = createContext(
      "/api/lifeops/sleep/baseline?windowDays=365",
    );

    await expect(handleSleepRoutes(context)).resolves.toBe(true);

    expect(error).not.toHaveBeenCalled();
    expect(getPersonalBaseline).toHaveBeenCalledWith({ windowDays: 365 });
    expect(json).toHaveBeenCalledWith(
      context.res,
      expect.objectContaining({ sampleSize: 0, windowDays: 365 }),
    );
  });

  it("rejects sleep windows beyond the route maximum before service dispatch", async () => {
    const getSleepHistory = vi.spyOn(
      LifeOpsService.prototype,
      "getSleepHistory",
    );
    const { context, error, json } = createContext(
      "/api/lifeops/sleep/history?windowDays=366",
    );

    await expect(handleSleepRoutes(context)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(
      context.res,
      "windowDays must be at most 365",
      400,
    );
    expect(json).not.toHaveBeenCalled();
    expect(getSleepHistory).not.toHaveBeenCalled();
  });

  it("returns false for non-sleep routes", async () => {
    const { context, error, json } = createContext("/api/lifeops/overview");

    await expect(handleSleepRoutes(context)).resolves.toBe(false);

    expect(error).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
});
