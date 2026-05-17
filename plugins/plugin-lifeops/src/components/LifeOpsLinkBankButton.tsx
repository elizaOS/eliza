/**
 * LifeOpsLinkBankButton — drives the Plaid Link flow for the Money page.
 *
 * Flow:
 *   1. On mount of the modal, fetch a fresh `link_token` from Eliza Cloud via
 *      `client.createLifeOpsPlaidLinkToken()`.
 *   2. Hand that token to `usePlaidLink` so the Plaid Link UI can drive the
 *      bank-selection / login / account-picker flow client-side.
 *   3. On `onSuccess(public_token)`, exchange the token via
 *      `client.completeLifeOpsPlaidLink({ publicToken })`. Eliza Cloud
 *      exchanges the public_token for a long-lived `access_token`, never
 *      surfaces the secret to the browser, and we get back a fresh
 *      payment-source row.
 *   4. Caller's `onLinked` runs the dashboard refresh.
 *
 * The Plaid `link_token` is short-lived; if the user opens the modal but
 * cancels, we re-fetch on the next attempt. We do NOT persist link_tokens.
 */
import { client, useApp } from "@elizaos/ui";
import { Banknote, Loader2 } from "lucide-react";
import { type JSX, useCallback, useEffect, useState } from "react";
import { type PlaidLinkOnSuccess, usePlaidLink } from "react-plaid-link";
import type { LifeOpsPaymentSource } from "../lifeops/payment-types.js";

interface LifeOpsLinkBankButtonProps {
  onLinked?: (source: LifeOpsPaymentSource) => void;
  /** Optional override for the trigger label. Default: "Link bank with Plaid". */
  label?: string;
  /** Optional override for the disabled-state title. */
  unavailableTitle?: string;
}

export function LifeOpsLinkBankButton({
  onLinked,
  label = "Link bank with Plaid",
  unavailableTitle = "Plaid link is not available — Eliza Cloud not connected, or PLAID_* env vars not set in cloud.",
}: LifeOpsLinkBankButtonProps): JSX.Element {
  const { elizaCloudConnected } = useApp();
  const [linkToken, setLinkToken] = useState<string | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [exchangeStatus, setExchangeStatus] = useState<
    "idle" | "exchanging" | "done" | "error"
  >("idle");
  const [exchangeError, setExchangeError] = useState<string | null>(null);

  const fetchLinkToken = useCallback(async () => {
    setTokenLoading(true);
    setTokenError(null);
    try {
      const data = await client.createLifeOpsPlaidLinkToken();
      setLinkToken(data.linkToken);
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : String(err));
    } finally {
      setTokenLoading(false);
    }
  }, []);

  const onSuccess = useCallback<PlaidLinkOnSuccess>(
    async (publicToken, _metadata) => {
      setExchangeStatus("exchanging");
      setExchangeError(null);
      try {
        const result = await client.completeLifeOpsPlaidLink({
          publicToken,
        });
        setExchangeStatus("done");
        // Burn the link_token — Plaid only allows it once, and we want a
        // fresh one on the next attempt.
        setLinkToken(null);
        onLinked?.(result.source);
      } catch (err) {
        setExchangeStatus("error");
        setExchangeError(err instanceof Error ? err.message : String(err));
      }
    },
    [onLinked],
  );

  // We feed `usePlaidLink` an empty token when we don't have one yet —
  // the hook tolerates this and just won't be `ready`. This keeps the
  // hook unconditional (rules-of-hooks) and lets us drive opening on
  // demand without two render passes.
  const { open, ready } = usePlaidLink({
    token: linkToken ?? "",
    onSuccess,
  });

  // When we have a token AND Plaid Link is ready, open it automatically.
  // The button click only triggers `fetchLinkToken`; `open()` runs in this
  // effect once Link reports ready.
  useEffect(() => {
    if (linkToken && ready) {
      open();
    }
  }, [linkToken, ready, open]);

  const onClick = useCallback(() => {
    setExchangeStatus("idle");
    setExchangeError(null);
    void fetchLinkToken();
  }, [fetchLinkToken]);

  const disabled =
    !elizaCloudConnected || tokenLoading || exchangeStatus === "exchanging";

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        title={!elizaCloudConnected ? unavailableTitle : undefined}
        className="inline-flex items-center gap-1.5 rounded-md border border-border/30 bg-bg-muted/30 px-2.5 py-1 text-xs font-medium hover:bg-bg-muted/60 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {tokenLoading || exchangeStatus === "exchanging" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
        ) : (
          <Banknote className="h-3.5 w-3.5" aria-hidden />
        )}
        {exchangeStatus === "exchanging"
          ? "Linking…"
          : exchangeStatus === "done"
            ? "Linked"
            : tokenLoading
              ? "Preparing Plaid…"
              : label}
      </button>
      {tokenError ? (
        <span className="text-[11px] text-rose-300">Plaid: {tokenError}</span>
      ) : null}
      {exchangeError ? (
        <span className="text-[11px] text-rose-300">
          Exchange failed: {exchangeError}
        </span>
      ) : null}
    </div>
  );
}
