/**
 * Billing body — credit balance, buy-credits (Stripe card + crypto), auto-fund
 * settings, and invoice history. Mounted by the in-app settings billing
 * section. Crypto direct-payments render only when `/api/crypto/status`
 * reports the direct wallet enabled, and the wallet UI is gated behind
 * {@link ConditionalWalletProviders} by the mounting surface.
 */

"use client";

import {
  BrandButton,
  BrandCard,
  CornerBrackets,
  Input,
  Label,
} from "@elizaos/ui/cloud-ui";
import {
  AlertCircle,
  CheckCircle,
  Clock,
  CreditCard,
  Loader2,
  Wallet,
  XCircle,
} from "lucide-react";
import type { ComponentType, FormEvent } from "react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { isSafeNavigationUrl } from "../../lib/navigation-url";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  type BillingSnapshotV2View,
  useBillingSnapshotV2,
} from "../data/billing-snapshot";
import { formatExactUsd } from "../lib/format-exact-usd";
import type {
  BillingUser,
  CryptoStatusResponse,
  InvoiceDisplay,
} from "../types";
import {
  ActiveComputeCardView,
  type BillingSnapshotViewState,
} from "./active-compute-card";
import { AutoTopUpCard } from "./auto-top-up-card";

// Lazy-loaded so its @solana/spl-token + @solana/web3.js imports — which eval
// top-level PublicKey program-id constants through safe-buffer's Buffer() at
// module load — stay OUT of the app boot graph (they crashed boot with
// "Class constructor Buffer cannot be invoked without 'new'"). They now load
// only when the crypto payment UI actually renders, matching the existing
// ConditionalWalletProviders lazy-gating intent.
const DirectCryptoCreditCard = lazy(() =>
  import("./direct-crypto-credit-card").then((m) => ({
    default: m.DirectCryptoCreditCard,
  })),
);

import { Button } from "../../../components/ui/button";

interface BillingTabProps {
  user: BillingUser;
}

const AMOUNT_LIMITS = {
  MIN: 1,
  MAX: 10000,
} as const;

type PaymentMethod = "card" | "crypto";

const AMOUNT_HINT_ID = "purchase-amount-hint";
const AMOUNT_ERROR_ID = "purchase-amount-error";

function toSnapshotViewState(query: {
  data: BillingSnapshotV2View | undefined;
  isError: boolean;
  isFetching: boolean;
  isRefetchError: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
}): BillingSnapshotViewState {
  if (query.data) {
    return {
      kind: "ready",
      snapshot: query.data,
      refreshing: query.isFetching,
      refreshPaused: query.fetchStatus === "paused",
      refreshFailed: query.isRefetchError,
    };
  }
  if (query.fetchStatus === "paused") return { kind: "paused" };
  if (query.isError) {
    return { kind: "error", retrying: query.isFetching };
  }
  return { kind: "loading" };
}

function BalanceValue({ state }: { state: BillingSnapshotViewState }) {
  const t = useCloudT();

  if (state.kind === "loading") {
    return (
      <span
        role="status"
        aria-label={t("cloud.billing.compute.balanceLoading", {
          defaultValue: "Loading balance",
        })}
        className="inline-block h-12 w-44 max-w-full animate-pulse bg-bg-accent motion-reduce:animate-none"
      />
    );
  }
  if (state.kind === "paused" || state.kind === "error") {
    return t("cloud.billing.compute.balanceUnavailable", {
      defaultValue: "Balance unavailable",
    });
  }

  const { balance } = state.snapshot;
  if (balance.status === "available") {
    return formatExactUsd(balance.value.balance.value);
  }
  if (balance.status === "unknown_policy") {
    return t("cloud.billing.compute.pendingPolicy", {
      defaultValue: "Pending policy",
    });
  }
  if (balance.status === "not_applicable") {
    return t("cloud.billing.compute.notApplicable", {
      defaultValue: "Not applicable",
    });
  }
  return t("cloud.billing.compute.balanceUnavailable", {
    defaultValue: "Balance unavailable",
  });
}

function observedTimestamp(value: string): string {
  return value
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC")
    .replace(/Z$/, " UTC");
}

function BalanceFreshness({ state }: { state: BillingSnapshotViewState }) {
  const t = useCloudT();
  if (state.kind !== "ready" || state.snapshot.balance.status !== "available") {
    return null;
  }

  const observedAt = observedTimestamp(state.snapshot.balance.observedAt);
  if (state.refreshPaused) {
    return (
      <p className="text-center text-xs text-warn">
        {t("cloud.billing.compute.balanceRefreshPaused", {
          observedAt,
          defaultValue:
            "Balance refresh paused. Showing the value observed at {{observedAt}}.",
        })}
      </p>
    );
  }
  if (state.refreshFailed) {
    return (
      <p className="text-center text-xs text-warn">
        {t("cloud.billing.compute.balanceRefreshFailed", {
          observedAt,
          defaultValue:
            "Could not refresh balance. Showing the value observed at {{observedAt}}.",
        })}
      </p>
    );
  }
  if (state.refreshing) {
    return (
      <p className="text-center text-xs text-muted-strong">
        {t("cloud.billing.compute.balanceRefreshing", {
          observedAt,
          defaultValue:
            "Refreshing balance. Showing the value observed at {{observedAt}}.",
        })}
      </p>
    );
  }
  return (
    <p className="text-center font-mono text-xs text-muted">
      {t("cloud.billing.compute.balanceObservedAt", {
        observedAt,
        defaultValue: "Balance observed {{observedAt}}",
      })}
    </p>
  );
}

function canRetryBalance(
  state: BillingSnapshotViewState,
): state is Extract<BillingSnapshotViewState, { kind: "ready" }> {
  return (
    state.kind === "ready" &&
    state.snapshot.balance.status === "unavailable" &&
    state.snapshot.balance.error.retryable
  );
}

// Status is never conveyed by color alone: every branch pairs a lucide glyph
// with the verbatim status text so screen-reader and monochrome users read the
// same state as sighted color users.
function getInvoiceStatusPresentation(status: string): {
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  className: string;
} {
  const normalized = status.trim().toLowerCase();
  if (["paid", "succeeded", "complete", "completed"].includes(normalized)) {
    return { Icon: CheckCircle, className: "text-green-400" };
  }
  if (
    ["failed", "uncollectible", "void", "canceled", "cancelled"].includes(
      normalized,
    )
  ) {
    return { Icon: XCircle, className: "text-red-400" };
  }
  if (["pending", "open", "processing", "draft"].includes(normalized)) {
    return { Icon: Clock, className: "text-txt-strong" };
  }
  return { Icon: AlertCircle, className: "text-muted-strong" };
}

export function BillingTab({ user }: BillingTabProps) {
  const t = useCloudT();
  const navigate = useNavigate();
  const billingSnapshot = useBillingSnapshotV2(user.organization_id);
  const billingSnapshotState = toSnapshotViewState(billingSnapshot);
  const [invoices, setInvoices] = useState<InvoiceDisplay[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(true);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [purchaseAmount, setPurchaseAmount] = useState("");

  // Idempotency intent for the card checkout (#24144): the server requires an
  // Idempotency-Key (8-128 chars of [A-Za-z0-9._:-]) for non-hardware credit
  // purchases and scopes durable checkout orders to (org, key). A UUID is
  // generated only after validation, reused while the purchase intent (the
  // amount) is unchanged so ambiguous/transient failures can replay safely,
  // and cleared when the amount changes or a definitive client-side failure
  // (plain 4xx) proves the server never accepted the intent. Deliberately a
  // single-slot ref, NOT a per-amount map: editing A -> B -> A must not
  // resurrect A's earlier key as a "same intent" replay.
  const checkoutIntentRef = useRef<{ amount: number; key: string } | null>(null);
  // Tracks whether a submit has been attempted so an empty submission (which
  // never populates purchaseAmount) still marks the field invalid and renders
  // the adjacent inline error instead of only emitting a transient toast.
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [isProcessingCheckout, setIsProcessingCheckout] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  const [cryptoStatus, setCryptoStatus] = useState<CryptoStatusResponse | null>(
    null,
  );

  const fetchInvoices = useCallback(async () => {
    setLoadingInvoices(true);
    setInvoicesError(null);
    try {
      const data = await api<{ invoices?: InvoiceDisplay[] }>(
        "/api/invoices/list",
      );
      setInvoices(data.invoices ?? []);
    } catch (error) {
      setInvoicesError(
        error instanceof Error
          ? error.message
          : "Invoice history could not be loaded.",
      );
    } finally {
      setLoadingInvoices(false);
    }
  }, []);

  const fetchCryptoStatus = useCallback(async () => {
    try {
      const data = await api<CryptoStatusResponse>("/api/crypto/status");
      setCryptoStatus(data);
    } catch {
      // Crypto is optional; absence just hides the crypto payment path.
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchInvoices();
      void fetchCryptoStatus();
    });
  }, [fetchInvoices, fetchCryptoStatus]);

  const handleBuyCredits = async () => {
    const amount = parseFloat(purchaseAmount);

    if (Number.isNaN(amount) || amount < AMOUNT_LIMITS.MIN) {
      toast.error(
        t("cloud.billingTab.minAmount", {
          min: AMOUNT_LIMITS.MIN,
          defaultValue: "Minimum amount is $" + "{{min}}",
        }),
      );
      return;
    }

    if (amount > AMOUNT_LIMITS.MAX) {
      toast.error(
        t("cloud.billingTab.maxAmount", {
          max: AMOUNT_LIMITS.MAX,
          defaultValue: "Maximum amount is $" + "{{max}}",
        }),
      );
      return;
    }

    setIsProcessingCheckout(true);

    if (paymentMethod === "crypto" && cryptoStatus?.directWallet?.enabled) {
      // The DirectCryptoCreditCard owns the direct-wallet flow.
      setIsProcessingCheckout(false);
      return;
    }

    if (paymentMethod === "crypto") {
      try {
        const data = await api<{ payLink?: string }>("/api/crypto/payments", {
          method: "POST",
          json: { amount },
        });
        if (!data.payLink) {
          toast.error(
            t("cloud.billingTab.noPaymentLink", {
              defaultValue: "No payment link returned",
            }),
          );
          setIsProcessingCheckout(false);
          return;
        }
        if (!isSafeNavigationUrl(data.payLink)) {
          // The payment link is a wire value assigned to the top window — only
          // absolute http(s) may navigate; anything else is an error state.
          toast.error(
            t("cloud.billingTab.invalidPaymentLink", {
              defaultValue: "Payment link is not a valid URL",
            }),
          );
          setIsProcessingCheckout(false);
          return;
        }
        toast.success(
          t("cloud.billingTab.redirectingPayment", {
            defaultValue: "Redirecting to payment page...",
          }),
        );
        window.location.href = data.payLink;
      } catch (error) {
        toast.error(
          error instanceof ApiError
            ? error.message
            : t("cloud.billingTab.createCryptoFailed", {
                defaultValue: "Failed to create crypto payment",
              }),
        );
        setIsProcessingCheckout(false);
      }
      return;
    }

    // Card checkout only. The crypto branches above have returned by here, so
    // the idempotency intent stays scoped to the route that requires it
    // (/api/stripe/create-checkout-session) and never touches crypto payments.
    const intent = checkoutIntentRef.current;
    const idempotencyKey =
      intent && intent.amount === amount ? intent.key : crypto.randomUUID();
    checkoutIntentRef.current = { amount, key: idempotencyKey };

    try {
      const data = await api<{ url?: string }>(
        "/api/stripe/create-checkout-session",
        {
          method: "POST",
          json: { amount, returnUrl: "settings" },
          headers: { "Idempotency-Key": idempotencyKey },
        },
      );
      if (!data.url) {
        toast.error(
          t("cloud.billingTab.noCheckoutUrl", {
            defaultValue: "No checkout URL returned",
          }),
        );
        setIsProcessingCheckout(false);
        return;
      }
      if (!isSafeNavigationUrl(data.url)) {
        // The checkout URL is a wire value assigned to the top window — only
        // absolute http(s) may navigate; anything else is an error state.
        toast.error(
          t("cloud.billingTab.invalidCheckoutUrl", {
            defaultValue: "Checkout URL is not a valid URL",
          }),
        );
        setIsProcessingCheckout(false);
        return;
      }
      window.location.href = data.url;
    } catch (error) {
      // Preserve the idempotency key across ambiguous/transient outcomes
      // (network errors, 408/429, 5xx): the server may have created the
      // durable checkout order before the response was lost, and replaying
      // the same key reconciles to it instead of double-ordering. Clear it
      // only on definitive client-side failures (plain 4xx except 408/429):
      // those prove the server rejected the request before creating anything.
      // Known edge: if the HTTP status was received but the response body
      // stream itself fails mid-read, the transport error escapes as a
      // non-ApiError — including after a 4xx. That case conservatively
      // PRESERVES the key: we cannot prove the server's 4xx semantics were
      // for this request, so treating it as ambiguous is the safe direction
      // (worst case, the retry hits the server's own key/digest conflict).
      if (
        error instanceof ApiError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 429
      ) {
        checkoutIntentRef.current = null;
      }
      toast.error(
        error instanceof ApiError
          ? error.message
          : t("cloud.billingTab.createCheckoutFailed", {
              defaultValue: "Failed to create checkout session",
            }),
      );
      setIsProcessingCheckout(false);
    }
  };

  // Enter inside the amount field submits the form; keep the network call in
  // handleBuyCredits so click and keyboard paths share one code path. Record
  // the attempt first so an empty/invalid submit surfaces the inline error and
  // aria-invalid even though handleBuyCredits returns before any checkout call.
  const handleSubmitBuy = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitAttempted(true);
    void handleBuyCredits();
  };

  const handleViewInvoice = (invoice: InvoiceDisplay) => {
    navigate(`/cloud/invoices/${invoice.id}`);
  };

  const parsedAmountValue = Number.parseFloat(purchaseAmount);
  const amountValue = Number.isNaN(parsedAmountValue)
    ? null
    : parsedAmountValue;
  const isValidAmount =
    amountValue !== null &&
    amountValue >= AMOUNT_LIMITS.MIN &&
    amountValue <= AMOUNT_LIMITS.MAX;
  const showAmountError =
    (purchaseAmount.length > 0 || submitAttempted) && !isValidAmount;
  const amountDescribedBy = showAmountError
    ? `${AMOUNT_HINT_ID} ${AMOUNT_ERROR_ID}`
    : AMOUNT_HINT_ID;

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* Credit Balance Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-muted" />
            <h3 className="text-base font-mono text-txt uppercase">
              {t("cloud.billingTab.creditBalance", {
                defaultValue: "Credit Balance",
              })}
            </h3>
          </div>

          <div className="flex flex-col lg:flex-row gap-6 w-full">
            <div className="w-full lg:w-[400px] flex">
              <div className="bg-surface border border-brand-surface flex-1 flex items-center justify-center py-6 lg:py-8">
                <div className="flex flex-col items-center justify-center gap-1 px-4">
                  <div
                    aria-live="polite"
                    className="break-words text-center font-mono text-2xl tracking-tight text-txt-strong tabular-nums [overflow-wrap:anywhere] sm:text-[40px]"
                  >
                    <BalanceValue state={billingSnapshotState} />
                  </div>
                  <p className="text-sm text-muted text-center">
                    {t("cloud.billingTab.remainingBalance", {
                      defaultValue: "Remaining balance",
                    })}
                  </p>
                  <BalanceFreshness state={billingSnapshotState} />
                  {canRetryBalance(billingSnapshotState) ? (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => {
                        void billingSnapshot.refetch();
                      }}
                      disabled={billingSnapshotState.refreshing}
                      className="mt-3 min-h-11 min-w-11 font-mono"
                    >
                      {billingSnapshotState.refreshing
                        ? t("cloud.billing.compute.retrying", {
                            defaultValue: "Retrying…",
                          })
                        : t("cloud.billing.compute.balanceRetry", {
                            defaultValue: "Retry balance",
                          })}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="flex-1 flex flex-col gap-6 lg:justify-center">
              <div className="flex flex-col gap-4">
                <p className="text-base font-mono text-txt">
                  {t("cloud.billingTab.addCredits", {
                    defaultValue: "Add credits to your account",
                  })}
                </p>
                <p id={AMOUNT_HINT_ID} className="text-sm text-muted-strong">
                  {t("cloud.billingTab.amountHint", {
                    min: AMOUNT_LIMITS.MIN,
                    max: AMOUNT_LIMITS.MAX,
                    defaultValue:
                      "Enter the amount you want to add. Min: $" +
                      "{{min}}" +
                      ", Max: $" +
                      "{{max}}",
                  })}
                </p>

                {cryptoStatus?.enabled && (
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => setPaymentMethod("card")}
                      aria-pressed={paymentMethod === "card"}
                      className={`flex items-center gap-2 px-4 py-2 font-mono text-sm border transition-colors ${
                        paymentMethod === "card"
                          ? "bg-txt border-txt text-bg"
                          : "bg-transparent border-border text-muted hover:border-border-strong"
                      }`}
                    >
                      <CreditCard className="h-4 w-4" />
                      {t("cloud.billingTab.card", { defaultValue: "Card" })}
                    </Button>
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => setPaymentMethod("crypto")}
                      aria-pressed={paymentMethod === "crypto"}
                      className={`flex items-center gap-2 px-4 py-2 font-mono text-sm border transition-colors ${
                        paymentMethod === "crypto"
                          ? "bg-txt border-txt text-bg"
                          : "bg-transparent border-border text-muted hover:border-border-strong"
                      }`}
                    >
                      <Wallet className="h-4 w-4" />
                      {t("cloud.billingTab.crypto", { defaultValue: "Crypto" })}
                    </Button>
                  </div>
                )}

                <form
                  onSubmit={handleSubmitBuy}
                  className="flex flex-col sm:flex-row items-stretch sm:items-start gap-4"
                >
                  <div className="flex-1 max-w-xs">
                    <Label
                      htmlFor="purchase-amount"
                      className="mb-1.5 block text-muted-strong font-mono text-xs"
                    >
                      {t("cloud.billingTab.amountLabel", {
                        defaultValue: "Amount (USD)",
                      })}
                    </Label>
                    <div className="relative">
                      <span className="absolute left-3 top-[22px] -translate-y-1/2 text-muted-strong font-mono z-10 pointer-events-none">
                        $
                      </span>
                      <Input
                        id="purchase-amount"
                        type="number"
                        step="1"
                        min={AMOUNT_LIMITS.MIN}
                        max={AMOUNT_LIMITS.MAX}
                        value={purchaseAmount}
                        onChange={(e) => {
                          setPurchaseAmount(e.target.value);
                          if (submitAttempted) setSubmitAttempted(false);
                          // Note: the idempotency intent is intentionally NOT
                          // cleared on edit here. Intermediate keystrokes
                          // ("2" while retyping "25") would clear a still-
                          // valid intent prematurely; the authoritative
                          // rotation check is at submit time, where the full
                          // parsed amount is compared against the recorded
                          // intent (#24144).
                        }}
                        className="pl-7 bg-surface border border-border text-txt h-11 font-mono tabular-nums"
                        placeholder="0.00"
                        disabled={isProcessingCheckout}
                        aria-describedby={amountDescribedBy}
                        aria-invalid={showAmountError}
                      />
                    </div>
                    {showAmountError && (
                      <div
                        id={AMOUNT_ERROR_ID}
                        role="alert"
                        className="mt-1.5 flex items-center gap-2 text-sm text-red-400"
                      >
                        <AlertCircle
                          className="h-4 w-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="font-mono">
                          {amountValue === null ||
                          amountValue < AMOUNT_LIMITS.MIN
                            ? t("cloud.billingTab.minAmount", {
                                min: AMOUNT_LIMITS.MIN,
                                defaultValue: "Minimum amount is $" + "{{min}}",
                              })
                            : t("cloud.billingTab.maxAmount", {
                                max: AMOUNT_LIMITS.MAX,
                                defaultValue: "Maximum amount is $" + "{{max}}",
                              })}
                        </span>
                      </div>
                    )}
                  </div>

                  {(paymentMethod !== "crypto" ||
                    !cryptoStatus?.directWallet?.enabled) && (
                    <BrandButton
                      type="submit"
                      variant="primary"
                      disabled={isProcessingCheckout}
                      className="h-11 px-6 w-full sm:w-auto flex-shrink-0 font-mono text-base whitespace-nowrap sm:mt-[26px] disabled:border disabled:border-border disabled:bg-surface disabled:text-muted disabled:opacity-100"
                    >
                      {isProcessingCheckout ? (
                        <>
                          <Loader2
                            className="h-4 w-4 animate-spin"
                            aria-hidden="true"
                          />
                          {t("cloud.billingTab.processing", {
                            defaultValue: "Processing\u2026",
                          })}
                        </>
                      ) : paymentMethod === "crypto" ? (
                        t("cloud.billingTab.payWithCrypto", {
                          defaultValue: "Pay with Crypto",
                        })
                      ) : (
                        t("cloud.billingTab.buyCredits", {
                          defaultValue: "Buy credits",
                        })
                      )}
                    </BrandButton>
                  )}
                </form>

                {isValidAmount && purchaseAmount && amountValue !== null && (
                  <div className="flex items-center gap-2 text-sm text-green-400">
                    <CheckCircle className="h-4 w-4" />
                    <span className="font-mono">
                      {t("cloud.billingTab.willBeAdded", {
                        amount: amountValue.toFixed(2),
                        defaultValue:
                          "$" + "{{amount}}" + " will be added to your balance",
                      })}
                    </span>
                  </div>
                )}

                {paymentMethod === "crypto" &&
                  cryptoStatus?.directWallet?.enabled && (
                    <Suspense fallback={null}>
                      <DirectCryptoCreditCard
                        amount={amountValue}
                        status={cryptoStatus}
                        accountWalletAddress={user.wallet_address ?? null}
                        onSuccess={async () => {
                          await Promise.all([
                            billingSnapshot.refetch(),
                            fetchInvoices(),
                          ]);
                        }}
                      />
                    </Suspense>
                  )}
              </div>
            </div>
          </div>
        </div>
      </BrandCard>

      <ActiveComputeCardView
        state={billingSnapshotState}
        onRetry={() => {
          void billingSnapshot.refetch();
        }}
      />

      {/* Card auto top-up keeps the consumer billing path explicit and visible. */}
      <AutoTopUpCard />

      {/* Invoices Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-muted" />
              <h3 className="text-base font-mono text-txt uppercase">
                {t("cloud.billingTab.invoices", { defaultValue: "Invoices" })}
              </h3>
            </div>
            <p className="text-xs font-mono text-muted tracking-tight">
              {t("cloud.billingTab.invoicesDesc", {
                defaultValue:
                  "View your payment history and download invoices.",
              })}
            </p>
          </div>

          {/* No fixed min-width scroller: rows reflow to a stacked card at
              320px and only lay out as columns from `sm` up. */}
          <div className="w-full">
            <div className="hidden sm:flex w-full">
              <div className="bg-surface border border-brand-surface flex-[1.5] p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colDateTime", {
                    defaultValue: "Date & Time",
                  })}
                </p>
              </div>
              <div className="bg-surface border-t border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colTotal", { defaultValue: "Total" })}
                </p>
              </div>
              <div className="bg-surface border-t border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colStatus", {
                    defaultValue: "Status",
                  })}
                </p>
              </div>
              <div className="bg-surface border-t border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colActions", {
                    defaultValue: "Actions",
                  })}
                </p>
              </div>
            </div>

            {loadingInvoices ? (
              <div className="flex items-center justify-center p-8 border border-brand-surface sm:border-t-0">
                <Loader2 className="h-6 w-6 animate-spin text-muted" />
              </div>
            ) : invoicesError ? (
              <div className="flex items-start gap-3 p-8 border border-brand-surface sm:border-t-0 bg-red-500/5">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <div className="space-y-1">
                  <p className="text-xs md:text-sm text-red-300 font-mono">
                    {t("cloud.billingTab.invoiceLoadFailed", {
                      defaultValue: "Invoice history could not be loaded",
                    })}
                  </p>
                  <p className="text-xs text-muted-strong font-mono">
                    {invoicesError}
                  </p>
                </div>
              </div>
            ) : invoices.length === 0 ? (
              <div className="flex items-center justify-center p-8 border border-brand-surface sm:border-t-0">
                <p className="text-xs md:text-sm text-muted-strong font-mono">
                  {t("cloud.billingTab.noInvoices", {
                    defaultValue: "No invoices yet",
                  })}
                </p>
              </div>
            ) : (
              invoices.map((invoice) => {
                const { Icon: StatusIcon, className: statusClassName } =
                  getInvoiceStatusPresentation(invoice.status);
                return (
                  <div
                    key={invoice.id}
                    data-testid="invoice-row"
                    className="flex flex-col sm:flex-row w-full border border-brand-surface sm:border-t-0"
                  >
                    <div className="flex-[1.5] p-3 md:p-4 flex items-center justify-between gap-3 border-b border-brand-surface sm:border-b-0">
                      <span className="sm:hidden text-xs font-mono font-bold uppercase text-muted-strong">
                        {t("cloud.billingTab.colDateTime", {
                          defaultValue: "Date & Time",
                        })}
                      </span>
                      <p className="text-xs md:text-sm font-mono text-txt-strong tabular-nums text-right sm:text-left">
                        {invoice.date}
                      </p>
                    </div>
                    <div className="flex-1 p-3 md:p-4 flex items-center justify-between gap-3 border-b border-brand-surface sm:border-b-0 sm:border-l">
                      <span className="sm:hidden text-xs font-mono font-bold uppercase text-muted-strong">
                        {t("cloud.billingTab.colTotal", {
                          defaultValue: "Total",
                        })}
                      </span>
                      <p className="text-xs md:text-sm font-mono text-txt-strong uppercase tabular-nums">
                        {invoice.total}
                      </p>
                    </div>
                    <div className="flex-1 p-3 md:p-4 flex items-center justify-between gap-3 border-b border-brand-surface sm:border-b-0 sm:border-l">
                      <span className="sm:hidden text-xs font-mono font-bold uppercase text-muted-strong">
                        {t("cloud.billingTab.colStatus", {
                          defaultValue: "Status",
                        })}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs md:text-sm font-mono uppercase ${statusClassName}`}
                      >
                        <StatusIcon
                          className="h-4 w-4 shrink-0"
                          aria-hidden={true}
                        />
                        <span>{invoice.status}</span>
                      </span>
                    </div>
                    <div className="flex-1 p-3 md:p-4 flex items-center justify-between gap-3 sm:border-l border-brand-surface">
                      <span className="sm:hidden text-xs font-mono font-bold uppercase text-muted-strong">
                        {t("cloud.billingTab.colActions", {
                          defaultValue: "Actions",
                        })}
                      </span>
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => handleViewInvoice(invoice)}
                        className="text-xs md:text-sm font-mono text-txt-strong underline uppercase hover:text-txt transition-colors"
                      >
                        {t("cloud.billingTab.view", { defaultValue: "View" })}
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </BrandCard>
    </div>
  );
}

export type { BillingUser };
