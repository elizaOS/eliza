/**
 * `createHealthSleepRouteHandler` — serves the read-only sleep history,
 * regularity, and personal-baseline endpoints from host-supplied service
 * methods, returning the LifeOps sleep response DTOs.
 */
import { logger } from "@elizaos/core";
import type {
  LifeOpsPersonalBaselineResponse,
  LifeOpsSleepHistoryResponse,
  LifeOpsSleepRegularityResponse,
} from "../contracts/health.js";

const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;

export interface HealthSleepRouteContext<TResponse = unknown> {
  method: string;
  pathname: string;
  url: URL;
  res: TResponse;
  json: (res: TResponse, data: unknown, status?: number) => void;
  error: (res: TResponse, message: string, status?: number) => void;
}

export interface HealthSleepRouteService {
  getSleepHistory(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepHistoryResponse>;
  getSleepRegularity(opts?: {
    windowDays?: number;
    includeNaps?: boolean;
  }): Promise<LifeOpsSleepRegularityResponse>;
  getPersonalBaseline(opts?: {
    windowDays?: number;
  }): Promise<LifeOpsPersonalBaselineResponse>;
}

export interface CreateHealthSleepRouteHandlerOptions<
  TContext extends HealthSleepRouteContext,
> {
  createService: (
    ctx: TContext,
  ) => HealthSleepRouteService | null | Promise<HealthSleepRouteService | null>;
}

class HealthSleepRouteError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HealthSleepRouteError";
  }
}

function parseWindowDaysQuery(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (!/^\d+$/.test(trimmed)) {
    throw new HealthSleepRouteError(
      400,
      "windowDays must be a positive integer",
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < MIN_WINDOW_DAYS) {
    throw new HealthSleepRouteError(
      400,
      `windowDays must be at least ${MIN_WINDOW_DAYS}`,
    );
  }
  if (parsed > MAX_WINDOW_DAYS) {
    throw new HealthSleepRouteError(
      400,
      `windowDays must be at most ${MAX_WINDOW_DAYS}`,
    );
  }
  return parsed;
}

function parseIncludeNapsQuery(value: string | null): boolean | undefined {
  if (value === null) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "") {
    return undefined;
  }
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new HealthSleepRouteError(400, "includeNaps must be a boolean");
}

function routeErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const status = "status" in error ? error.status : undefined;
  if (
    typeof status === "number" &&
    Number.isInteger(status) &&
    status >= 400 &&
    status <= 599
  ) {
    return status;
  }
  return null;
}

function routeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createHealthSleepRouteHandler<
  TContext extends HealthSleepRouteContext,
>(options: CreateHealthSleepRouteHandlerOptions<TContext>) {
  async function runSleepRoute(
    ctx: TContext,
    fn: (service: HealthSleepRouteService) => Promise<void>,
  ): Promise<boolean> {
    const operation = `${ctx.method.toUpperCase()} ${ctx.pathname}`;
    const service = await options.createService(ctx);
    if (!service) {
      return true;
    }
    try {
      await fn(service);
      return true;
    } catch (error) {
      // error-policy:J1 HTTP route boundary; an expected client-error shape is
      // translated into a status response, while an unexpected failure is
      // logged at error and rethrown to the host (never a fabricated 200).
      const status = routeErrorStatus(error);
      if (status !== null) {
        logger.warn(
          {
            boundary: "plugin-health",
            operation,
            statusCode: status,
          },
          `[plugin-health] Sleep route failed: ${routeErrorMessage(error)}`,
        );
        ctx.error(ctx.res, routeErrorMessage(error), status);
        return true;
      }
      logger.error(
        {
          boundary: "plugin-health",
          operation,
        },
        `[plugin-health] Sleep route crashed: ${routeErrorMessage(error)}`,
      );
      throw error;
    }
  }

  return async function handleHealthSleepRoutes(
    ctx: TContext,
  ): Promise<boolean> {
    const { method, pathname, url, json, res } = ctx;

    if (method === "GET" && pathname === "/api/lifeops/sleep/history") {
      return runSleepRoute(ctx, async (service) => {
        const windowDays = parseWindowDaysQuery(
          url.searchParams.get("windowDays"),
        );
        const includeNaps = parseIncludeNapsQuery(
          url.searchParams.get("includeNaps"),
        );
        const response = await service.getSleepHistory({
          windowDays,
          includeNaps,
        });
        json(res, response);
      });
    }

    if (method === "GET" && pathname === "/api/lifeops/sleep/regularity") {
      return runSleepRoute(ctx, async (service) => {
        const windowDays = parseWindowDaysQuery(
          url.searchParams.get("windowDays"),
        );
        const includeNaps = parseIncludeNapsQuery(
          url.searchParams.get("includeNaps"),
        );
        const response = await service.getSleepRegularity({
          windowDays,
          includeNaps,
        });
        json(res, response);
      });
    }

    if (method === "GET" && pathname === "/api/lifeops/sleep/baseline") {
      return runSleepRoute(ctx, async (service) => {
        const windowDays = parseWindowDaysQuery(
          url.searchParams.get("windowDays"),
        );
        const response = await service.getPersonalBaseline({ windowDays });
        json(res, response);
      });
    }

    return false;
  };
}
