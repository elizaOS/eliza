/**
 * useConnectorReconnect — orchestrates the reconnect → reauth → auto-retry loop
 * for a connector account that blocked an action (a failed send, a write the
 * agent could not complete because the account needs reauth, etc.).
 *
 * Backend contract this hook is built against:
 *   - The OAuth redirect/return is owned entirely by the backend. There is no
 *     callback the browser can subscribe to. The only observable signal of a
 *     successful reauth is the account record flipping its `status` to
 *     "connected".
 *   - The caller therefore supplies two thunks: `reconnect` (triggers the
 *     existing OAuth flow — typically opens the auth URL in a new tab) and
 *     `pollStatus` (re-reads the account's live status; wire this to the same
 *     source `AccountRequiredCard` already consumes — e.g.
 *     `useConnectorAccounts().refreshAccount` / `listConnectorAccounts`).
 *
 * The hook starts the reconnect, then polls `pollStatus` until the account is
 * usable again (or an explicit success signal arrives), then invokes
 * `retryAction` exactly once and reports the outcome. Cancellation is
 * cooperative: in-flight polls and the retry are abandoned and ignored.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ConnectorAccountActionResult,
  ConnectorAccountRecord,
  ConnectorAccountStatus,
} from "../api/client-agent";

export type ConnectorReconnectPhase =
  | "idle"
  | "reconnecting"
  | "retrying"
  | "success"
  | "failed";

/**
 * Result of a single `pollStatus` call. Either the resolved account record (the
 * hook reads its `status`) or an explicit terminal signal so callers whose
 * status source does not return a full record can still drive the loop.
 */
export type ConnectorReconnectStatusProbe =
  | ConnectorAccountRecord
  | { status: ConnectorAccountStatus | "connected" }
  | { connected: boolean }
  | null;

export interface UseConnectorReconnectOptions {
  /**
   * Triggers the connector reauth flow for `accountId`. Usually opens the OAuth
   * URL in a new tab. The returned value is ignored unless it already reports
   * `status === "connected"` (some providers reconnect inline without a
   * redirect), which short-circuits polling. A plain void-returning callback is
   * accepted — its `undefined` result simply means "poll for the status flip".
   */
  reconnect: (
    accountId: string,
  ) =>
    | ConnectorAccountActionResult
    | undefined
    | Promise<ConnectorAccountActionResult | undefined>;
  /**
   * Re-reads the live status of `accountId`. Called on an interval after the
   * reauth flow starts. Return the account record (or a terminal signal) so the
   * hook can detect the flip to "connected".
   */
  pollStatus: (
    accountId: string,
  ) => Promise<ConnectorReconnectStatusProbe> | ConnectorReconnectStatusProbe;
  /** Interval between status polls, ms. Default 2000. */
  pollIntervalMs?: number;
  /**
   * Give up waiting for reauth after this long, ms. Default 180000 (3 min — a
   * realistic OAuth round-trip budget). Set 0 to poll indefinitely until
   * cancelled.
   */
  timeoutMs?: number;
  /** Called once after a successful auto-retry. */
  onSuccess?: () => void;
  /** Called once when reauth or the retry fails (or times out / is cancelled). */
  onError?: (error: Error) => void;
}

export interface UseConnectorReconnectResult {
  phase: ConnectorReconnectPhase;
  /** True while reconnecting or retrying. */
  busy: boolean;
  /** The account id currently being reconnected, or null when idle. */
  activeAccountId: string | null;
  error: string | null;
  /**
   * Begin the reconnect → reauth → retry loop. `retryAction` is the thunk that
   * re-runs the original failed action (resend the message, re-issue the
   * write). It runs only after the account is usable again.
   */
  start: (accountId: string, retryAction: () => Promise<void>) => void;
  /** Abandon the in-flight loop. In-flight poll/retry results are ignored. */
  cancel: () => void;
  /** Return to idle, clearing any terminal (success/failed) state. */
  reset: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 180_000;

function probeIsConnected(probe: ConnectorReconnectStatusProbe): boolean {
  if (!probe) return false;
  if ("connected" in probe) return probe.connected === true;
  if (probe.status) return probe.status === "connected";
  return false;
}

function toError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string" && value.trim()) return new Error(value);
  return new Error(fallback);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function useConnectorReconnect(
  options: UseConnectorReconnectOptions,
): UseConnectorReconnectResult {
  const {
    reconnect,
    pollStatus,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onSuccess,
    onError,
  } = options;

  const [phase, setPhase] = useState<ConnectorReconnectPhase>("idle");
  const [activeAccountId, setActiveAccountId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  // Keep the latest callbacks/config in refs so an in-flight loop never closes
  // over stale values and so `start`/`cancel` stay stable.
  const cfgRef = useRef({
    reconnect,
    pollStatus,
    pollIntervalMs,
    timeoutMs,
    onSuccess,
    onError,
  });
  cfgRef.current = {
    reconnect,
    pollStatus,
    pollIntervalMs,
    timeoutMs,
    onSuccess,
    onError,
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const finishError = useCallback((err: Error, signal: AbortSignal) => {
    if (signal.aborted || !mountedRef.current) return;
    setPhase("failed");
    setError(err.message);
    cfgRef.current.onError?.(err);
  }, []);

  const start = useCallback(
    (accountId: string, retryAction: () => Promise<void>) => {
      if (!accountId) return;
      // Supersede any in-flight loop.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const { signal } = controller;

      setActiveAccountId(accountId);
      setError(null);
      setPhase("reconnecting");

      void (async () => {
        const cfg = cfgRef.current;
        try {
          const startResult = await cfg.reconnect(accountId);
          if (signal.aborted) return;

          const startedConnected =
            !!startResult &&
            typeof startResult === "object" &&
            (startResult.status === "connected" ||
              startResult.account?.status === "connected");

          if (!startedConnected) {
            const deadline =
              cfg.timeoutMs > 0
                ? Date.now() + cfg.timeoutMs
                : Number.POSITIVE_INFINITY;
            let connected = false;
            while (!signal.aborted && Date.now() < deadline) {
              await delay(cfg.pollIntervalMs, signal);
              const probe = await cfg.pollStatus(accountId);
              if (signal.aborted) return;
              if (probeIsConnected(probe)) {
                connected = true;
                break;
              }
            }
            if (signal.aborted) return;
            if (!connected) {
              finishError(
                new Error(
                  "Timed out waiting for the account to reconnect. Finish the sign-in, then try again.",
                ),
                signal,
              );
              return;
            }
          }

          if (signal.aborted || !mountedRef.current) return;
          setPhase("retrying");
          await retryAction();
          if (signal.aborted || !mountedRef.current) return;
          setPhase("success");
          setError(null);
          cfg.onSuccess?.();
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") return;
          finishError(
            toError(
              err,
              "Reconnect and retry failed. Please try the action again.",
            ),
            signal,
          );
        }
      })();
    },
    [finishError],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    if (!mountedRef.current) return;
    setPhase("idle");
    setActiveAccountId(null);
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setPhase((prev) =>
      prev === "success" || prev === "failed" ? "idle" : prev,
    );
    setError(null);
    setActiveAccountId((prev) =>
      phase === "success" || phase === "failed" ? null : prev,
    );
  }, [phase]);

  return {
    phase,
    busy: phase === "reconnecting" || phase === "retrying",
    activeAccountId,
    error,
    start,
    cancel,
    reset,
  };
}
