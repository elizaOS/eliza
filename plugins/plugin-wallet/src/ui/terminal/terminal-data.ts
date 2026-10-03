/**
 * Data hooks for the crypto terminal: the polled live market list, one asset's
 * price history, and the per-browser paper ledger and watchlist.
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
} from "../../contracts.ts";
import {
  type PaperLedger,
  type ParsedPaperLedger,
  parsePaperLedger,
  settleOpenPaperOrders,
} from "./paper-ledger.ts";

export const TERMINAL_MARKETS_POLL_MS = 60_000;
export const PAPER_LEDGER_STORAGE_KEY = "eliza:wallet:paper-terminal:v1";
export const WATCHLIST_STORAGE_KEY = "eliza:wallet:terminal-watchlist:v1";
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

export function useTerminalMarkets(): RemoteState<WalletTerminalMarketsResponse> {
  const [state, setState] = useState<
    RemoteState<WalletTerminalMarketsResponse>
  >({ status: "loading" });

  useEffect(() => {
    let active = true;
    const load = () => {
      client
        .fetch<WalletTerminalMarketsResponse>("/api/wallet/terminal/markets")
        .then((data) => {
          if (active) setState({ status: "ready", data, refreshError: null });
        })
        .catch((error: unknown) => {
          // error-policy:J4 the view renders a distinct unavailable state.
          if (!active) return;
          const message = describeError(error);
          setState((previous) =>
            previous.status === "ready"
              ? { ...previous, refreshError: message }
              : { status: "error", message },
          );
        });
    };
    load();
    const timer = setInterval(load, TERMINAL_MARKETS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  return state;
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
