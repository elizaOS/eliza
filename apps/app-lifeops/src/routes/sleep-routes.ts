import { logger } from "@elizaos/core";
import { LifeOpsService, LifeOpsServiceError } from "../lifeops/service.js";
import type { LifeOpsRouteContext } from "./lifeops-routes.js";

const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;

function getService(ctx: LifeOpsRouteContext): LifeOpsService | null {
  if (!ctx.state.runtime) {
    ctx.error(ctx.res, "Agent runtime is not available", 503);
    return null;
  }
  return new LifeOpsService(ctx.state.runtime, {
    ownerEntityId: ctx.state.adminEntityId,
  });
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
    throw new LifeOpsServiceError(400, "windowDays must be a positive integer");
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (parsed < MIN_WINDOW_DAYS) {
    throw new LifeOpsServiceError(
      400,
      `windowDays must be at least ${MIN_WINDOW_DAYS}`,
    );
  }
  if (parsed > MAX_WINDOW_DAYS) {
    throw new LifeOpsServiceError(
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
  throw new LifeOpsServiceError(400, "includeNaps must be a boolean");
}

async function runSleepRoute(
  ctx: LifeOpsRouteContext,
  fn: (service: LifeOpsService) => Promise<void>,
): Promise<boolean> {
  const operation = `${ctx.method.toUpperCase()} ${ctx.pathname}`;
  const service = getService(ctx);
  if (!service) {
    return true;
  }
  try {
    await fn(service);
    return true;
  } catch (error) {
    if (error instanceof LifeOpsServiceError) {
      logger.warn(
        {
          boundary: "lifeops",
          operation,
          statusCode: error.status,
        },
        `[lifeops] Sleep route failed: ${error.message}`,
      );
      ctx.error(ctx.res, error.message, error.status);
      return true;
    }
    logger.error(
      {
        boundary: "lifeops",
        operation,
      },
      `[lifeops] Sleep route crashed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
}

export async function handleSleepRoutes(
  ctx: LifeOpsRouteContext,
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
}
