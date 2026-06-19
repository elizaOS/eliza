// Structural validators for the Polymarket BFF DTOs.
//
// These assert that a value produced by `handlePolymarketRoute` (the BFF) is a
// real, contract-shaped DTO — not just that some object came back. They are the
// single source of truth shared by:
//   - routes.contract.test.ts  (replays recorded real responses, keyless)
//   - routes.real.test.ts      (re-fetches the live public API, drift check)
//   - the app UI mock fixtures  (helpers.ts must produce DTOs that pass these)
//
// `numericString` is intentionally stricter than the interface's `string | null`:
// the parser only ever emits raw numeric strings (e.g. "4279700.63974") via
// `readNumericString`, so a pre-formatted string like "$12,345" is a real defect
// the validator catches.

import type {
  PolymarketMarket,
  PolymarketMarketResponse,
  PolymarketMarketsResponse,
  PolymarketOrderbookResponse,
  PolymarketStatusResponse,
} from "../polymarket-contracts";

type Violations = string[];

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function checkStringOrNull(v: Violations, path: string, value: unknown): void {
  if (value !== null && typeof value !== "string") {
    v.push(`${path}: expected string|null, got ${describe(value)}`);
  }
}

function checkBooleanOrNull(v: Violations, path: string, value: unknown): void {
  if (value !== null && typeof value !== "boolean") {
    v.push(`${path}: expected boolean|null, got ${describe(value)}`);
  }
}

// numeric string (the real-API contract for prices/volumes/liquidity) or null.
function checkNumericStringOrNull(
  v: Violations,
  path: string,
  value: unknown,
): void {
  if (value === null) return;
  if (typeof value !== "string") {
    v.push(`${path}: expected numeric-string|null, got ${describe(value)}`);
    return;
  }
  if (value.trim() === "" || !Number.isFinite(Number(value))) {
    v.push(
      `${path}: expected a numeric string (parser emits raw numerics), got ${JSON.stringify(value)}`,
    );
  }
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array[${value.length}]`;
  return typeof value;
}

export function validateMarket(market: unknown, path = "market"): Violations {
  const v: Violations = [];
  if (typeof market !== "object" || market === null) {
    return [`${path}: expected object, got ${describe(market)}`];
  }
  const m = market as PolymarketMarket;
  if (!isNonEmptyString(m.id)) v.push(`${path}.id: expected non-empty string`);
  for (const key of [
    "slug",
    "question",
    "description",
    "category",
    "conditionId",
    "image",
    "icon",
    "endDate",
    "startDate",
    "updatedAt",
  ] as const) {
    checkStringOrNull(v, `${path}.${key}`, m[key]);
  }
  for (const key of [
    "active",
    "closed",
    "archived",
    "restricted",
    "enableOrderBook",
  ] as const) {
    checkBooleanOrNull(v, `${path}.${key}`, m[key]);
  }
  for (const key of [
    "liquidity",
    "volume",
    "volume24hr",
    "lastTradePrice",
    "bestBid",
    "bestAsk",
  ] as const) {
    checkNumericStringOrNull(v, `${path}.${key}`, m[key]);
  }
  if (!Array.isArray(m.clobTokenIds)) {
    v.push(`${path}.clobTokenIds: expected string[]`);
  } else if (!m.clobTokenIds.every(isString)) {
    v.push(`${path}.clobTokenIds: every entry must be a string`);
  }
  if (!Array.isArray(m.outcomes)) {
    v.push(`${path}.outcomes: expected outcome[]`);
  } else {
    m.outcomes.forEach((o, i) => {
      if (!isString(o?.name)) {
        v.push(`${path}.outcomes[${i}].name: expected string`);
      }
      checkNumericStringOrNull(v, `${path}.outcomes[${i}].price`, o?.price);
    });
  }
  return v;
}

function validateSource(
  v: Violations,
  path: string,
  source: unknown,
  api: "gamma" | "data" | "clob",
): void {
  if (typeof source !== "object" || source === null) {
    v.push(`${path}: expected source object`);
    return;
  }
  const s = source as { api?: unknown; endpoint?: unknown };
  if (s.api !== api)
    v.push(`${path}.api: expected "${api}", got ${describe(s.api)}`);
  if (!isNonEmptyString(s.endpoint)) {
    v.push(`${path}.endpoint: expected non-empty string`);
  }
}

export function validateMarketsResponse(value: unknown): Violations {
  const v: Violations = [];
  if (typeof value !== "object" || value === null) {
    return ["response: expected object"];
  }
  const r = value as PolymarketMarketsResponse;
  if (!Array.isArray(r.markets)) {
    v.push("markets: expected array");
  } else {
    r.markets.forEach((m, i) => v.push(...validateMarket(m, `markets[${i}]`)));
  }
  validateSource(v, "source", r.source, "gamma");
  return v;
}

export function validateMarketResponse(value: unknown): Violations {
  const v: Violations = [];
  if (typeof value !== "object" || value === null) {
    return ["response: expected object"];
  }
  const r = value as PolymarketMarketResponse;
  if (r.market !== null) v.push(...validateMarket(r.market, "market"));
  validateSource(v, "source", r.source, "gamma");
  return v;
}

export function validateOrderbookResponse(value: unknown): Violations {
  const v: Violations = [];
  if (typeof value !== "object" || value === null) {
    return ["response: expected object"];
  }
  const r = value as PolymarketOrderbookResponse;
  if (!isNonEmptyString(r.tokenId))
    v.push("tokenId: expected non-empty string");
  checkStringOrNull(v, "market", r.market);
  checkStringOrNull(v, "assetId", r.assetId);
  for (const side of ["bids", "asks"] as const) {
    const levels = r[side];
    if (!Array.isArray(levels)) {
      v.push(`${side}: expected level[]`);
      continue;
    }
    levels.forEach((lvl, i) => {
      checkNumericStringOrNull(v, `${side}[${i}].price`, lvl?.price);
      checkNumericStringOrNull(v, `${side}[${i}].size`, lvl?.size);
      if (lvl?.price === null) v.push(`${side}[${i}].price: must not be null`);
      if (lvl?.size === null) v.push(`${side}[${i}].size: must not be null`);
    });
  }
  for (const key of [
    "bestBid",
    "bestBidSize",
    "bestAsk",
    "bestAskSize",
    "midpoint",
    "spread",
    "lastTradePrice",
    "tickSize",
  ] as const) {
    checkNumericStringOrNull(v, key, r[key]);
  }
  if (typeof r.bidLevels !== "number") v.push("bidLevels: expected number");
  if (typeof r.askLevels !== "number") v.push("askLevels: expected number");
  validateSource(v, "source", r.source, "clob");
  return v;
}

export function validateStatusResponse(value: unknown): Violations {
  const v: Violations = [];
  if (typeof value !== "object" || value === null) {
    return ["response: expected object"];
  }
  const r = value as PolymarketStatusResponse;
  if (typeof r.publicReads?.ready !== "boolean") {
    v.push("publicReads.ready: expected boolean");
  }
  if (!isNonEmptyString(r.publicReads?.gammaApiBase)) {
    v.push("publicReads.gammaApiBase: expected non-empty string");
  }
  if (!isNonEmptyString(r.publicReads?.dataApiBase)) {
    v.push("publicReads.dataApiBase: expected non-empty string");
  }
  if (typeof r.trading?.ready !== "boolean") {
    v.push("trading.ready: expected boolean");
  }
  if (typeof r.trading?.credentialsReady !== "boolean") {
    v.push("trading.credentialsReady: expected boolean");
  }
  if (!Array.isArray(r.trading?.missing)) {
    v.push("trading.missing: expected array");
  }
  if (!isNonEmptyString(r.trading?.clobApiBase)) {
    v.push("trading.clobApiBase: expected non-empty string");
  }
  return v;
}
