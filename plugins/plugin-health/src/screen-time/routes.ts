/**
 * Owns parsing and dispatch for the three screen-time HTTP reads while hosts
 * retain authentication, response serialization, and route mounting.
 */
import { ElizaError } from "@elizaos/core";
import { LIFEOPS_SCREEN_TIME_RANGES } from "../contracts/lifeops.js";
import type { ScreenTimeAggregationService } from "./service.js";

export class ScreenTimeRouteError extends ElizaError {
  readonly status = 400;

  constructor(message: string) {
    super(message, { code: "SCREEN_TIME_REQUEST_INVALID" });
  }
}

function positiveInteger(value: string | null, field: string, max: number) {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (!/^\d+$/.test(normalized)) {
    throw new ScreenTimeRouteError(`${field} must be a positive integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new ScreenTimeRouteError(
      `${field} must be an integer from 1 to ${max}`,
    );
  }
  return parsed;
}

function boundedWindow(url: URL) {
  const since = url.searchParams.get("since")?.trim();
  const until = url.searchParams.get("until")?.trim();
  const isoInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
  if (
    !since ||
    !until ||
    !isoInstant.test(since) ||
    !isoInstant.test(until) ||
    !Number.isFinite(Date.parse(since)) ||
    !Number.isFinite(Date.parse(until)) ||
    Date.parse(until) <= Date.parse(since)
  ) {
    throw new ScreenTimeRouteError(
      "since and until must be valid ISO strings with until > since",
    );
  }
  if (Date.parse(until) - Date.parse(since) > 31 * 24 * 60 * 60 * 1000) {
    throw new ScreenTimeRouteError("window must be 31 days or less");
  }
  return { since, until };
}

function source(url: URL): "app" | "website" | undefined {
  const value = url.searchParams.get("source")?.trim().toLowerCase();
  if (!value) return undefined;
  if (value !== "app" && value !== "website") {
    throw new ScreenTimeRouteError("source must be app or website");
  }
  return value;
}

export async function handleScreenTimeReadRoute(input: {
  method: string;
  pathname: string;
  url: URL;
  service: ScreenTimeAggregationService;
}): Promise<{ handled: false } | { handled: true; body: unknown }> {
  if (input.method !== "GET") return { handled: false };
  const identifier =
    input.url.searchParams.get("identifier")?.trim() || undefined;
  if (input.pathname === "/api/lifeops/screen-time/summary") {
    return {
      handled: true,
      body: await input.service.getScreenTimeSummary({
        ...boundedWindow(input.url),
        source: source(input.url),
        identifier,
        topN: positiveInteger(input.url.searchParams.get("topN"), "topN", 20),
      }),
    };
  }
  if (input.pathname === "/api/lifeops/screen-time/breakdown") {
    return {
      handled: true,
      body: await input.service.getScreenTimeBreakdown({
        ...boundedWindow(input.url),
        source: source(input.url),
        identifier,
        topN: positiveInteger(input.url.searchParams.get("topN"), "topN", 50),
      }),
    };
  }
  if (input.pathname === "/api/lifeops/screen-time/history") {
    const range =
      input.url.searchParams.get("range")?.trim().toLowerCase() || "today";
    if (!(LIFEOPS_SCREEN_TIME_RANGES as readonly string[]).includes(range)) {
      throw new ScreenTimeRouteError(
        `range must be one of: ${LIFEOPS_SCREEN_TIME_RANGES.join(", ")}`,
      );
    }
    return {
      handled: true,
      body: await input.service.getScreenTimeHistory({
        range: range as (typeof LIFEOPS_SCREEN_TIME_RANGES)[number],
        topN: positiveInteger(input.url.searchParams.get("topN"), "topN", 50),
        socialTopN: positiveInteger(
          input.url.searchParams.get("socialTopN"),
          "socialTopN",
          50,
        ),
      }),
    };
  }
  return { handled: false };
}
