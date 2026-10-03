/**
 * Price alerts for the crypto terminal: a pure, storage-agnostic list of
 * one-shot "above" / "below" targets checked against live prices.
 *
 * An alert fires once, the first time a live price reaches its target, and is
 * then kept as triggered with the price that met it. An alert whose condition
 * already holds is refused at creation so it cannot fire on the next refresh
 * as a false signal. Alerts are checked only in HUNT and SLEEP; OFF pauses
 * them along with market polling. Persisted input is untrusted and goes
 * through {@link parsePriceAlerts}. Nothing here trades.
 */
import type { TerminalOperatingMode } from "./operating-mode.ts";

export type PriceAlertDirection = "above" | "below";

export interface PriceAlert {
  id: string;
  assetId: string;
  symbol: string;
  direction: PriceAlertDirection;
  targetUsd: number;
  createdAt: number;
  /** Epoch milliseconds when a live price first met the target. */
  triggeredAt: number | null;
  /** The live price that met the target. */
  triggeredPriceUsd: number | null;
}

export interface PriceAlertState {
  version: 1;
  alerts: PriceAlert[];
}

export interface PriceAlertInput {
  assetId: string;
  symbol: string;
  direction: PriceAlertDirection;
  targetUsd: number;
  /** Live price when the alert is set. */
  currentUsd: number;
}

export type PriceAlertRejection = "invalid-price" | "already-met";

export type ParsedPriceAlerts =
  | { status: "empty" | "ok"; state: PriceAlertState }
  | { status: "invalid"; state: PriceAlertState; error: string };

export function createPriceAlertState(): PriceAlertState {
  return { version: 1, alerts: [] };
}

/** Alerts are evaluated only while the terminal is watching prices. */
export function alertsActive(mode: TerminalOperatingMode): boolean {
  return mode !== "off";
}

function meets(
  direction: PriceAlertDirection,
  priceUsd: number,
  targetUsd: number,
): boolean {
  return direction === "above" ? priceUsd >= targetUsd : priceUsd <= targetUsd;
}

export function addPriceAlert(
  state: PriceAlertState,
  input: PriceAlertInput,
  id: string,
  now: number,
):
  | { ok: true; state: PriceAlertState; alert: PriceAlert }
  | { ok: false; reason: PriceAlertRejection } {
  if (!Number.isFinite(input.targetUsd) || input.targetUsd <= 0) {
    return { ok: false, reason: "invalid-price" };
  }
  if (meets(input.direction, input.currentUsd, input.targetUsd)) {
    return { ok: false, reason: "already-met" };
  }
  const alert: PriceAlert = {
    id,
    assetId: input.assetId,
    symbol: input.symbol,
    direction: input.direction,
    targetUsd: input.targetUsd,
    createdAt: now,
    triggeredAt: null,
    triggeredPriceUsd: null,
  };
  return {
    ok: true,
    state: { ...state, alerts: [alert, ...state.alerts] },
    alert,
  };
}

export function removePriceAlert(
  state: PriceAlertState,
  id: string,
): PriceAlertState {
  return { ...state, alerts: state.alerts.filter((alert) => alert.id !== id) };
}

/**
 * Fire every waiting alert whose asset has a live price meeting its target.
 * Assets without a live price are left waiting rather than guessed.
 */
export function checkPriceAlerts(
  state: PriceAlertState,
  prices: ReadonlyMap<string, number>,
  now: number,
): { state: PriceAlertState; triggered: PriceAlert[] } {
  const triggered: PriceAlert[] = [];
  const alerts = state.alerts.map((alert) => {
    if (alert.triggeredAt !== null) return alert;
    const price = prices.get(alert.assetId);
    if (price === undefined || !Number.isFinite(price)) return alert;
    if (!meets(alert.direction, price, alert.targetUsd)) return alert;
    const fired = { ...alert, triggeredAt: now, triggeredPriceUsd: price };
    triggered.push(fired);
    return fired;
  });
  return triggered.length === 0
    ? { state, triggered }
    : { state: { ...state, alerts }, triggered };
}

function isAlert(value: unknown): value is PriceAlert {
  if (typeof value !== "object" || value === null) return false;
  const alert = value as Record<string, unknown>;
  const finite = (key: string) =>
    typeof alert[key] === "number" && Number.isFinite(alert[key]);
  const finiteOrNull = (key: string) => alert[key] === null || finite(key);
  return (
    typeof alert.id === "string" &&
    typeof alert.assetId === "string" &&
    typeof alert.symbol === "string" &&
    (alert.direction === "above" || alert.direction === "below") &&
    finite("targetUsd") &&
    (alert.targetUsd as number) > 0 &&
    finite("createdAt") &&
    finiteOrNull("triggeredAt") &&
    finiteOrNull("triggeredPriceUsd")
  );
}

/** Parse stored alerts; anything unreadable starts an empty list and says why. */
export function parsePriceAlerts(raw: string | null): ParsedPriceAlerts {
  if (raw === null) return { status: "empty", state: createPriceAlertState() };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    // error-policy:J3 an unreadable record becomes an explicit invalid result.
    return {
      status: "invalid",
      state: createPriceAlertState(),
      error: "Saved price alerts were not valid JSON",
    };
  }
  const record = value as { version?: unknown; alerts?: unknown } | null;
  if (
    record?.version !== 1 ||
    !Array.isArray(record.alerts) ||
    !record.alerts.every(isAlert)
  ) {
    return {
      status: "invalid",
      state: createPriceAlertState(),
      error: "Saved price alerts had an unexpected shape",
    };
  }
  return { status: "ok", state: { version: 1, alerts: record.alerts } };
}
