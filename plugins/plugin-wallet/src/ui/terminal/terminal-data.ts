/**
 * Data hooks for the crypto terminal: the polled live market list, one asset's
 * price history, and the per-browser paper ledger and watchlist.
 *
 * It also owns the persisted HUNT / SLEEP / OFF operating mode, price alerts,
 * and the on-demand Solana token safety lookup.
 *
 * Market reads go through the authenticated app client to the plugin's
 * read-only `/api/wallet/terminal/*` routes. Loading, error, and ready are
 * distinct states; a failed refresh keeps the last list visible but marks it
 * so the view never presents stale prices as live. Paper state persists via
 * the shell's sanctioned `shellLocalStorage` channel under `eliza:wallet:`.
 */
import { client } from "@elizaos/ui/api";
import { shellLocalStorage } from "@elizaos/ui/bridge";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  WalletTerminalChartDays,
  WalletTerminalChartResponse,
  WalletTerminalMarketsResponse,
  WalletTerminalTokenSafetyResponse,
} from "../../contracts.ts";
import {
  changeOperatingMode,
  type OperatingModeState,
  parseOperatingModeState,
  type TerminalOperatingMode,
} from "./operating-mode.ts";
import {
  type PaperLedger,
  type ParsedPaperLedger,
  parsePaperLedger,
  settleOpenPaperOrders,
} from "./paper-ledger.ts";
import {
  addPriceAlert,
  checkPriceAlerts,
  type PriceAlert,
  type PriceAlertInput,
  type PriceAlertRejection,
  type PriceAlertState,
  parsePriceAlerts,
  removePriceAlert,
} from "./price-alerts.ts";

export const TERMINAL_MARKETS_POLL_MS = 60_000;
export const PAPER_LEDGER_STORAGE_KEY = "eliza:wallet:paper-terminal:v1";
export const WATCHLIST_STORAGE_KEY = "eliza:wallet:terminal-watchlist:v1";
export const OPERATING_MODE_STORAGE_KEY = "eliza:wallet:terminal-mode:v1";
export const PRICE_ALERTS_STORAGE_KEY = "eliza:wallet:terminal-alerts:v1";
const DEFAULT_WATCHLIST = ["bitcoin", "ethereum", "solana"];

export type RemoteState<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T; refreshError: string | null };

function describeError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "Request failed";
}

/** Market list state; `idle` means nothing was requested yet (mode OFF). */
export type TerminalMarketsState =
  | RemoteState<WalletTerminalMarketsResponse>
  | { status: "idle" };

/**
 * The live market list. With `autoRefresh` it loads at once and polls; without
 * it (mode OFF) it makes no request until `refresh` is called.
 */
export function useTerminalMarkets(autoRefresh: boolean): {
  state: TerminalMarketsState;
  refresh: () => void;
} {
  const [state, setState] = useState<TerminalMarketsState>(
    autoRefresh ? { status: "loading" } : { status: "idle" },
  );
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    setState((previous) =>
      previous.status === "idle" || previous.status === "error"
        ? { status: "loading" }
        : previous,
    );
    client
      .fetch<WalletTerminalMarketsResponse>("/api/wallet/terminal/markets")
      .then((data) => {
        if (mounted.current)
          setState({ status: "ready", data, refreshError: null });
      })
      .catch((error: unknown) => {
        // error-policy:J4 the view renders a distinct unavailable state.
        if (!mounted.current) return;
        const message = describeError(error);
        setState((previous) =>
          previous.status === "ready"
            ? { ...previous, refreshError: message }
            : { status: "error", message },
        );
      });
  }, []);

  useEffect(() => {
    if (!autoRefresh) return;
    refresh();
    const timer = setInterval(refresh, TERMINAL_MARKETS_POLL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, refresh]);

  return { state, refresh };
}

export function useTerminalChart(
  assetId: string,
  days: WalletTerminalChartDays,
): RemoteState<WalletTerminalChartResponse> {
  const [state, setState] = useState<RemoteState<WalletTerminalChartResponse>>({
    status: "loading",
  });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    const query = new URLSearchParams({ id: assetId, days: String(days) });
    client
      .fetch<WalletTerminalChartResponse>(
        `/api/wallet/terminal/chart?${query.toString()}`,
      )
      .then((data) => {
        if (active) setState({ status: "ready", data, refreshError: null });
      })
      .catch((error: unknown) => {
        // error-policy:J4 the chart renders a distinct unavailable state.
        if (active)
          setState({ status: "error", message: describeError(error) });
      });
    return () => {
      active = false;
    };
  }, [assetId, days]);

  return state;
}

function readStorage(key: string): string | null {
  return typeof window === "undefined"
    ? null
    : window.localStorage.getItem(key);
}

export interface PaperLedgerState {
  ledger: PaperLedger;
  /** Set when stored practice history could not be read. */
  loadError: string | null;
  update: (next: PaperLedger) => void;
  reset: () => void;
}

export function usePaperLedger(
  livePrices: ReadonlyMap<string, number> | null,
): PaperLedgerState {
  const initial = useMemo<ParsedPaperLedger>(
    () => parsePaperLedger(readStorage(PAPER_LEDGER_STORAGE_KEY)),
    [],
  );
  const [ledger, setLedger] = useState<PaperLedger>(initial.ledger);
  const [loadError, setLoadError] = useState<string | null>(
    initial.status === "invalid" ? initial.error : null,
  );
  const ledgerRef = useRef(ledger);
  ledgerRef.current = ledger;

  const update = useCallback((next: PaperLedger) => {
    setLedger(next);
    setLoadError(null);
    shellLocalStorage.setItem(PAPER_LEDGER_STORAGE_KEY, JSON.stringify(next));
  }, []);

  const reset = useCallback(() => {
    update(parsePaperLedger(null).ledger);
  }, [update]);

  useEffect(() => {
    if (!livePrices) return;
    const settled = settleOpenPaperOrders(
      ledgerRef.current,
      livePrices,
      Date.now(),
    );
    if (settled.filled.length > 0) update(settled.ledger);
  }, [livePrices, update]);

  return { ledger, loadError, update, reset };
}

function parseWatchlist(raw: string | null): string[] {
  if (raw === null) return DEFAULT_WATCHLIST;
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) &&
      value.every((item) => typeof item === "string")
      ? value
      : DEFAULT_WATCHLIST;
  } catch {
    // error-policy:J3 an unreadable watchlist is a per-browser convenience;
    // fall back to the documented defaults rather than failing the view.
    return DEFAULT_WATCHLIST;
  }
}

export function useWatchlist(): {
  ids: ReadonlySet<string>;
  toggle: (assetId: string) => void;
} {
  const [ids, setIds] = useState<string[]>(() =>
    parseWatchlist(readStorage(WATCHLIST_STORAGE_KEY)),
  );
  const toggle = useCallback((assetId: string) => {
    setIds((current) => {
      const next = current.includes(assetId)
        ? current.filter((id) => id !== assetId)
        : [...current, assetId];
      shellLocalStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);
  return { ids: useMemo(() => new Set(ids), [ids]), toggle };
}

export interface OperatingModeHandle extends OperatingModeState {
  /** Set when the stored mode could not be read and SLEEP was restored. */
  loadError: string | null;
  change: (to: TerminalOperatingMode) => void;
}

export function useOperatingMode(): OperatingModeHandle {
  const initial = useMemo(
    () => parseOperatingModeState(readStorage(OPERATING_MODE_STORAGE_KEY)),
    [],
  );
  const [state, setState] = useState<OperatingModeState>(initial.state);
  const [loadError, setLoadError] = useState<string | null>(
    initial.status === "invalid" ? initial.error : null,
  );
  const change = useCallback((to: TerminalOperatingMode) => {
    setState((current) => {
      const next = changeOperatingMode(current, to, Date.now());
      if (next !== current) {
        shellLocalStorage.setItem(
          OPERATING_MODE_STORAGE_KEY,
          JSON.stringify(next),
        );
      }
      return next;
    });
    setLoadError(null);
  }, []);
  return { ...state, loadError, change };
}

export type TokenSafetyState =
  | { status: "idle" }
  | { status: "loading"; mint: string }
  | { status: "error"; mint: string; message: string }
  | { status: "ready"; data: WalletTerminalTokenSafetyResponse };

/** On-demand GoPlus safety report for one Solana mint. */
export function useTokenSafety(): {
  state: TokenSafetyState;
  check: (mint: string) => void;
} {
  const [state, setState] = useState<TokenSafetyState>({ status: "idle" });
  const latest = useRef<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const check = useCallback((mint: string) => {
    latest.current = mint;
    setState({ status: "loading", mint });
    const query = new URLSearchParams({ mint });
    client
      .fetch<WalletTerminalTokenSafetyResponse>(
        `/api/wallet/terminal/token-safety?${query.toString()}`,
      )
      .then((data) => {
        if (mounted.current && latest.current === mint)
          setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        // error-policy:J4 the panel renders a distinct unavailable state.
        if (mounted.current && latest.current === mint)
          setState({ status: "error", mint, message: describeError(error) });
      });
  }, []);

  return { state, check };
}

export interface PriceAlertsHandle {
  alerts: PriceAlert[];
  /** Alerts fired since the terminal opened, newest first, until dismissed. */
  fired: PriceAlert[];
  /** Set when stored alerts could not be read and an empty list was started. */
  loadError: string | null;
  add: (input: PriceAlertInput) => PriceAlertRejection | null;
  remove: (id: string) => void;
  dismiss: (id: string) => void;
}

/** Persisted price alerts, checked against each new live price list while `active`. */
export function usePriceAlerts(
  livePrices: ReadonlyMap<string, number> | null,
  active: boolean,
): PriceAlertsHandle {
  const initial = useMemo(
    () => parsePriceAlerts(readStorage(PRICE_ALERTS_STORAGE_KEY)),
    [],
  );
  const [state, setState] = useState<PriceAlertState>(initial.state);
  const [loadError, setLoadError] = useState<string | null>(
    initial.status === "invalid" ? initial.error : null,
  );
  const [fired, setFired] = useState<PriceAlert[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const commit = useCallback((next: PriceAlertState) => {
    stateRef.current = next;
    setState(next);
    setLoadError(null);
    shellLocalStorage.setItem(PRICE_ALERTS_STORAGE_KEY, JSON.stringify(next));
  }, []);

  useEffect(() => {
    if (!active || !livePrices) return;
    const checked = checkPriceAlerts(stateRef.current, livePrices, Date.now());
    if (checked.triggered.length === 0) return;
    commit(checked.state);
    setFired((current) => [...checked.triggered, ...current]);
  }, [livePrices, active, commit]);

  const add = useCallback(
    (input: PriceAlertInput): PriceAlertRejection | null => {
      const result = addPriceAlert(
        stateRef.current,
        input,
        `alert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        Date.now(),
      );
      if (!result.ok) return result.reason;
      commit(result.state);
      return null;
    },
    [commit],
  );

  const remove = useCallback(
    (id: string) => {
      commit(removePriceAlert(stateRef.current, id));
      setFired((current) => current.filter((alert) => alert.id !== id));
    },
    [commit],
  );

  const dismiss = useCallback((id: string) => {
    setFired((current) => current.filter((alert) => alert.id !== id));
  }, []);

  return { alerts: state.alerts, fired, loadError, add, remove, dismiss };
}
