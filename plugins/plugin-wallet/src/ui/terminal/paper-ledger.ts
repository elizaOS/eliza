/**
 * Paper-trading ledger for the crypto terminal: a pure, storage-agnostic state
 * machine for practice cash, holdings, and orders priced from live market data.
 *
 * Nothing here signs, submits, or reaches a wallet. Market orders fill at the
 * live price passed in; limit orders reserve cash (buys) or units (sells) and
 * fill at their limit price once a later live price crosses it. Available
 * balances are always derived from open orders rather than stored, so a
 * reservation cannot drift from the order that owns it. Persisted input is
 * untrusted and goes through {@link parsePaperLedger}.
 */

export const PAPER_STARTING_CASH_USD = 10_000;
const DUST = 1e-9;

export type PaperOrderSide = "buy" | "sell";
export type PaperOrderType = "market" | "limit";
export type PaperOrderStatus = "filled" | "open" | "cancelled";

export interface PaperAsset {
  id: string;
  symbol: string;
  priceUsd: number;
}

export interface PaperOrder {
  id: string;
  assetId: string;
  symbol: string;
  side: PaperOrderSide;
  type: PaperOrderType;
  units: number;
  /** Fill price for market orders; limit price for limit orders. */
  priceUsd: number;
  notionalUsd: number;
  status: PaperOrderStatus;
  createdAt: number;
  closedAt: number | null;
}

export interface PaperHolding {
  symbol: string;
  units: number;
}

export interface PaperLedger {
  version: 1;
  cashUsd: number;
  holdings: Record<string, PaperHolding>;
  orders: PaperOrder[];
}

export interface PaperOrderInput {
  asset: PaperAsset;
  side: PaperOrderSide;
  type: PaperOrderType;
  /** USD to spend for a buy; units to sell for a sell. */
  amount: number;
  limitPriceUsd?: number;
}

export type PaperOrderRejection =
  | "invalid-amount"
  | "invalid-price"
  | "insufficient-cash"
  | "insufficient-units"
  | "too-small";

export type PaperOrderPreview =
  | { ok: true; units: number; priceUsd: number; notionalUsd: number }
  | { ok: false; reason: PaperOrderRejection };

export function createPaperLedger(
  cashUsd: number = PAPER_STARTING_CASH_USD,
): PaperLedger {
  return { version: 1, cashUsd, holdings: {}, orders: [] };
}

/** Cash not reserved by open limit buys. */
export function availableCashUsd(ledger: PaperLedger): number {
  const reserved = ledger.orders
    .filter((order) => order.status === "open" && order.side === "buy")
    .reduce((sum, order) => sum + order.notionalUsd, 0);
  return Math.max(0, ledger.cashUsd - reserved);
}

/** Units of an asset not reserved by open limit sells. */
export function availableUnits(ledger: PaperLedger, assetId: string): number {
  const held = ledger.holdings[assetId]?.units ?? 0;
  const reserved = ledger.orders
    .filter(
      (order) =>
        order.status === "open" &&
        order.side === "sell" &&
        order.assetId === assetId,
    )
    .reduce((sum, order) => sum + order.units, 0);
  return Math.max(0, held - reserved);
}

function isPositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function previewPaperOrder(
  ledger: PaperLedger,
  input: PaperOrderInput,
): PaperOrderPreview {
  if (!isPositive(input.amount)) return { ok: false, reason: "invalid-amount" };
  const priceUsd =
    input.type === "limit" ? input.limitPriceUsd : input.asset.priceUsd;
  if (!isPositive(priceUsd)) return { ok: false, reason: "invalid-price" };

  if (input.side === "buy") {
    if (input.amount > availableCashUsd(ledger) + DUST) {
      return { ok: false, reason: "insufficient-cash" };
    }
    const units = input.amount / priceUsd;
    if (units < DUST) return { ok: false, reason: "too-small" };
    return { ok: true, units, priceUsd, notionalUsd: input.amount };
  }

  if (input.amount > availableUnits(ledger, input.asset.id) + DUST) {
    return { ok: false, reason: "insufficient-units" };
  }
  const notionalUsd = input.amount * priceUsd;
  if (notionalUsd < DUST) return { ok: false, reason: "too-small" };
  return { ok: true, units: input.amount, priceUsd, notionalUsd };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function applyFill(ledger: PaperLedger, order: PaperOrder): PaperLedger {
  const current = ledger.holdings[order.assetId]?.units ?? 0;
  const units =
    order.side === "buy" ? current + order.units : current - order.units;
  const holdings = { ...ledger.holdings };
  if (units > DUST) {
    holdings[order.assetId] = { symbol: order.symbol, units };
  } else {
    delete holdings[order.assetId];
  }
  return {
    ...ledger,
    cashUsd: roundUsd(
      order.side === "buy"
        ? ledger.cashUsd - order.notionalUsd
        : ledger.cashUsd + order.notionalUsd,
    ),
    holdings,
  };
}

function limitCrossed(order: PaperOrder, priceUsd: number): boolean {
  return order.side === "buy"
    ? priceUsd <= order.priceUsd
    : priceUsd >= order.priceUsd;
}

/**
 * Place a paper order. Throws when the order no longer passes
 * {@link previewPaperOrder}, so a stale review can never overspend.
 */
export function placePaperOrder(
  ledger: PaperLedger,
  input: PaperOrderInput,
  id: string,
  now: number,
): { ledger: PaperLedger; order: PaperOrder } {
  const preview = previewPaperOrder(ledger, input);
  if (!preview.ok) {
    throw new Error(`Paper order rejected: ${preview.reason}`);
  }
  const base: PaperOrder = {
    id,
    assetId: input.asset.id,
    symbol: input.asset.symbol,
    side: input.side,
    type: input.type,
    units: preview.units,
    priceUsd: preview.priceUsd,
    notionalUsd: preview.notionalUsd,
    status: "open",
    createdAt: now,
    closedAt: null,
  };
  const marketable =
    input.type === "market" || limitCrossed(base, input.asset.priceUsd);
  if (!marketable) {
    return {
      ledger: { ...ledger, orders: [base, ...ledger.orders] },
      order: base,
    };
  }
  const filled: PaperOrder = { ...base, status: "filled", closedAt: now };
  return {
    ledger: applyFill(
      { ...ledger, orders: [filled, ...ledger.orders] },
      filled,
    ),
    order: filled,
  };
}

/** Fill every open limit order whose live price has crossed its limit. */
export function settleOpenPaperOrders(
  ledger: PaperLedger,
  livePrices: ReadonlyMap<string, number>,
  now: number,
): { ledger: PaperLedger; filled: PaperOrder[] } {
  let next = ledger;
  const filled: PaperOrder[] = [];
  for (const order of ledger.orders) {
    if (order.status !== "open") continue;
    const price = livePrices.get(order.assetId);
    if (price === undefined || !limitCrossed(order, price)) continue;
    const closed: PaperOrder = { ...order, status: "filled", closedAt: now };
    next = applyFill(
      {
        ...next,
        orders: next.orders.map((item) =>
          item.id === order.id ? closed : item,
        ),
      },
      closed,
    );
    filled.push(closed);
  }
  return { ledger: next, filled };
}

export function cancelPaperOrder(
  ledger: PaperLedger,
  orderId: string,
  now: number,
): PaperLedger {
  return {
    ...ledger,
    orders: ledger.orders.map((order) =>
      order.id === orderId && order.status === "open"
        ? { ...order, status: "cancelled", closedAt: now }
        : order,
    ),
  };
}

export interface PaperPosition {
  assetId: string;
  symbol: string;
  units: number;
  priceUsd: number | null;
  valueUsd: number | null;
}

export interface PaperValuation {
  cashUsd: number;
  positions: PaperPosition[];
  /** Null while any held asset lacks a live price. */
  totalUsd: number | null;
}

export function valuePaperLedger(
  ledger: PaperLedger,
  livePrices: ReadonlyMap<string, number>,
): PaperValuation {
  const positions = Object.entries(ledger.holdings)
    .map(([assetId, holding]) => {
      const priceUsd = livePrices.get(assetId) ?? null;
      return {
        assetId,
        symbol: holding.symbol,
        units: holding.units,
        priceUsd,
        valueUsd: priceUsd === null ? null : holding.units * priceUsd,
      };
    })
    .sort((left, right) => (right.valueUsd ?? -1) - (left.valueUsd ?? -1));
  const priced = positions.every((position) => position.valueUsd !== null);
  return {
    cashUsd: ledger.cashUsd,
    positions,
    totalUsd: priced
      ? positions.reduce(
          (sum, position) => sum + (position.valueUsd ?? 0),
          ledger.cashUsd,
        )
      : null,
  };
}

export type ParsedPaperLedger =
  | { status: "empty"; ledger: PaperLedger }
  | { status: "ok"; ledger: PaperLedger }
  | { status: "invalid"; ledger: PaperLedger; error: string };

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseOrder(value: unknown): PaperOrder | null {
  if (!value || typeof value !== "object") return null;
  const order = value as Record<string, unknown>;
  const valid =
    typeof order.id === "string" &&
    typeof order.assetId === "string" &&
    typeof order.symbol === "string" &&
    (order.side === "buy" || order.side === "sell") &&
    (order.type === "market" || order.type === "limit") &&
    (order.status === "filled" ||
      order.status === "open" ||
      order.status === "cancelled") &&
    isFiniteNonNegative(order.units) &&
    isFiniteNonNegative(order.priceUsd) &&
    isFiniteNonNegative(order.notionalUsd) &&
    isFiniteNonNegative(order.createdAt) &&
    (order.closedAt === null || isFiniteNonNegative(order.closedAt));
  return valid ? (order as unknown as PaperOrder) : null;
}

/**
 * Parse a persisted ledger. Missing storage yields a fresh ledger; anything
 * malformed yields an explicit `invalid` result so the UI can say so instead
 * of silently replacing the user's practice history.
 */
export function parsePaperLedger(raw: string | null): ParsedPaperLedger {
  if (raw === null) return { status: "empty", ledger: createPaperLedger() };
  const invalid = (error: string): ParsedPaperLedger => ({
    status: "invalid",
    ledger: createPaperLedger(),
    error,
  });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // error-policy:J3 corrupt storage becomes an explicit invalid result.
    return invalid("Saved paper portfolio is not valid JSON");
  }
  if (!value || typeof value !== "object") {
    return invalid("Saved paper portfolio is not an object");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    return invalid("Saved paper portfolio has an unknown version");
  }
  if (!isFiniteNonNegative(record.cashUsd)) {
    return invalid("Saved paper portfolio has an invalid cash balance");
  }
  if (!record.holdings || typeof record.holdings !== "object") {
    return invalid("Saved paper portfolio has invalid holdings");
  }
  const holdings: Record<string, PaperHolding> = {};
  for (const [assetId, holding] of Object.entries(
    record.holdings as Record<string, unknown>,
  )) {
    const item = holding as Record<string, unknown> | null;
    if (
      !item ||
      typeof item.symbol !== "string" ||
      !isFiniteNonNegative(item.units)
    ) {
      return invalid(`Saved paper holding ${assetId} is invalid`);
    }
    holdings[assetId] = { symbol: item.symbol, units: item.units };
  }
  if (!Array.isArray(record.orders)) {
    return invalid("Saved paper portfolio has invalid orders");
  }
  const orders: PaperOrder[] = [];
  for (const entry of record.orders) {
    const order = parseOrder(entry);
    if (!order) return invalid("Saved paper portfolio has an invalid order");
    orders.push(order);
  }
  return {
    status: "ok",
    ledger: { version: 1, cashUsd: record.cashUsd, holdings, orders },
  };
}
