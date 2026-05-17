/**
 * LifeOpsLinkPaypalButton — drives the PayPal OAuth Login flow for the
 * Money page using a popup window.
 *
 * Flow:
 *   1. User clicks the button.
 *   2. We mint a fresh `state` (CSRF nonce) and ask Eliza Cloud to build
 *      the PayPal authorize URL.
 *   3. Open a popup at that URL. PayPal redirects to the cloud's
 *      `popup-callback` page after consent; that page posts a message
 *      back to this window with `{ code, state, error }`.
 *   4. We verify the `state` matches the one we generated, then call
 *      `client.completeLifeOpsPaypalLink({ code })`. Eliza Cloud exchanges
 *      the code for tokens, persists them to the new payment_source row,
 *      and tells us whether the granted scope includes the Reporting API.
 *   5. If `capability.hasReporting === false`, the user is on a personal
 *      PayPal account; we show a CSV-export fallback prompt.
 */
import { client, useApp } from "@elizaos/ui";
import { Loader2, Wallet } from "lucide-react";
import { type JSX, useCallback, useEffect, useRef, useState } from "react";
import type { LifeOpsPaymentSource } from "../lifeops/payment-types.js";

interface LifeOpsLinkPaypalButtonProps {
  onLinked?: (
    source: LifeOpsPaymentSource,
    capability: { hasReporting: boolean; hasIdentity: boolean },
  ) => void;
  label?: string;
}

const POPUP_FEATURES = "width=560,height=720,resizable=yes,scrollbars=yes";
const POPUP_NAME = "eliza-paypal-oauth";
const POPUP_TIMEOUT_MS = 5 * 60 * 1000;
const ORIGIN_ALLOWLIST_ENV_FALLBACK = "*";

interface OauthMessage {
  type: "eliza-paypal-oauth";
  code: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

function isOauthMessage(value: unknown): value is OauthMessage {
  if (!value || typeof value !== "object") return false;
  const msg = value as Record<string, unknown>;
  return msg.type === "eliza-paypal-oauth";
}

export function LifeOpsLinkPaypalButton({
  onLinked,
  label = "Link PayPal",
}: LifeOpsLinkPaypalButtonProps): JSX.Element {
  const { elizaCloudConnected } = useApp();
  const [status, setStatus] = useState<
    "idle" | "preparing" | "awaiting_user" | "exchanging" | "done" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [capability, setCapability] = useState<{
    hasReporting: boolean;
    hasIdentity: boolean;
  } | null>(null);
  const popupRef = useRef<Window | null>(null);
  const stateRef = useRef<string | null>(null);
  const handlerRef = useRef<((event: MessageEvent) => void) | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    if (handlerRef.current) {
      window.removeEventListener("message", handlerRef.current);
      handlerRef.current = null;
    }
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
    }
    if (popupRef.current && !popupRef.current.closed) {
      try {
        popupRef.current.close();
      } catch {
        // Cross-origin closed by user — ignore.
      }
    }
    popupRef.current = null;
    stateRef.current = null;
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const onClick = useCallback(async () => {
    setError(null);
    setCapability(null);
    setStatus("preparing");
    const state = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
    stateRef.current = state;

    let authorizeUrl: string;
    try {
      const result = await client.createLifeOpsPaypalAuthorizeUrl({ state });
      authorizeUrl = result.url;
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : String(err));
      return;
    }

    const popup = window.open(authorizeUrl, POPUP_NAME, POPUP_FEATURES);
    if (!popup) {
      setStatus("error");
      setError(
        "Popup blocked. Allow popups for this site and try again, or use the CSV export from paypal.com.",
      );
      return;
    }
    popupRef.current = popup;
    setStatus("awaiting_user");

    const handler = (event: MessageEvent) => {
      const expectedOrigin =
        process.env.ELIZA_APP_ORIGIN ?? ORIGIN_ALLOWLIST_ENV_FALLBACK;
      if (
        expectedOrigin !== "*" &&
        event.origin &&
        event.origin !== window.location.origin &&
        event.origin !== expectedOrigin
      ) {
        // Drop messages from unexpected origins.
        return;
      }
      if (!isOauthMessage(event.data)) return;
      const payload = event.data;
      if (payload.state !== stateRef.current) {
        // Stale or forged message — ignore.
        return;
      }
      window.removeEventListener("message", handler);
      handlerRef.current = null;
      if (watchdogRef.current) {
        clearTimeout(watchdogRef.current);
        watchdogRef.current = null;
      }
      if (payload.error) {
        setStatus("error");
        setError(payload.errorDescription || payload.error);
        cleanup();
        return;
      }
      if (!payload.code) {
        setStatus("error");
        setError("PayPal returned no authorization code.");
        cleanup();
        return;
      }
      setStatus("exchanging");
      void client
        .completeLifeOpsPaypalLink({ code: payload.code })
        .then((result) => {
          setStatus("done");
          setCapability(result.capability);
          onLinked?.(result.source, result.capability);
        })
        .catch((err) => {
          setStatus("error");
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          cleanup();
        });
    };
    handlerRef.current = handler;
    window.addEventListener("message", handler);

    watchdogRef.current = setTimeout(() => {
      setStatus("error");
      setError("PayPal authorization timed out. Try again.");
      cleanup();
    }, POPUP_TIMEOUT_MS);
  }, [cleanup, onLinked]);

  const disabled =
    !elizaCloudConnected || status === "preparing" || status === "exchanging";

  let buttonLabel = label;
  if (status === "preparing") buttonLabel = "Preparing PayPal…";
  else if (status === "awaiting_user") buttonLabel = "Waiting for PayPal…";
  else if (status === "exchanging") buttonLabel = "Linking…";
  else if (status === "done") buttonLabel = "Linked";

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={
          !elizaCloudConnected
            ? "PayPal link is not available — Eliza Cloud not connected, or PAYPAL_* env vars not set in cloud."
            : undefined
        }
        className="inline-flex items-center gap-1.5 rounded-md border border-border/30 bg-bg-muted/30 px-2.5 py-1 text-xs font-medium hover:bg-bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {status === "preparing" || status === "exchanging" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Wallet className="h-3.5 w-3.5" aria-hidden />
        )}
        {buttonLabel}
      </button>
      {error ? (
        <span className="text-[11px] text-rose-300">PayPal: {error}</span>
      ) : null}
      {status === "done" && capability && !capability.hasReporting ? (
        <span className="text-[11px] text-amber-300">
          PayPal connected, but this account is personal-tier. Use CSV export
          from paypal.com → Activity → Statements to import transactions.
        </span>
      ) : null}
    </div>
  );
}
