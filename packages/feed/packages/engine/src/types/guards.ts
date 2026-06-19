/**
 * Type Guards - Centralized type guard functions for runtime type checking.
 */

import type { WorldEvent } from "./shared";

export const VALID_EVENT_TYPES = [
  "announcement",
  "meeting",
  "leak",
  "development",
  "scandal",
  "rumor",
  "deal",
  "conflict",
  "revelation",
  "development:occurred",
  "news:published",
] as const;

export function isValidEventType(type: string): type is WorldEvent["type"] {
  return (VALID_EVENT_TYPES as readonly string[]).includes(type);
}

export const VALID_VISIBILITY_VALUES = [
  "public",
  "leaked",
  "secret",
  "private",
  "group",
] as const;

export function isValidVisibility(
  vis: string,
): vis is WorldEvent["visibility"] {
  return (VALID_VISIBILITY_VALUES as readonly string[]).includes(vis);
}

export function isValidPointsToward(
  pt: string | null | undefined,
): pt is WorldEvent["pointsToward"] {
  return pt === null || pt === "YES" || pt === "NO";
}

export const VALID_MARKET_TYPES = ["perp", "prediction"] as const;

export function isValidMarketType(
  type: string,
): type is (typeof VALID_MARKET_TYPES)[number] {
  return VALID_MARKET_TYPES.includes(
    type as (typeof VALID_MARKET_TYPES)[number],
  );
}

export const VALID_TRADE_ACTIONS = [
  "open_long",
  "open_short",
  "buy_yes",
  "buy_no",
  "sell_yes",
  "sell_no",
  "close_position",
  "hold",
] as const;

export function isValidTradeAction(
  action: string,
): action is (typeof VALID_TRADE_ACTIONS)[number] {
  return (VALID_TRADE_ACTIONS as readonly string[]).includes(action);
}

export const VALID_QUESTION_STATUSES = [
  "active",
  "resolved",
  "pending",
  "cancelled",
] as const;

export function isValidQuestionStatus(
  status: string,
): status is (typeof VALID_QUESTION_STATUSES)[number] {
  return (VALID_QUESTION_STATUSES as readonly string[]).includes(status);
}

export function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  // Ensure plain-object semantics: prototype must be Object.prototype or null
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}
