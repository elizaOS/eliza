/**
 * Billing body — credit balance, buy-credits (Stripe card + crypto), auto-fund
 * settings, and invoice history. Mounted by the in-app settings billing
 * section. Crypto direct-payments render only when `/api/crypto/status`
 * reports the direct wallet enabled, and the wallet UI is gated behind
 * {@link ConditionalWalletProviders} by the mounting surface.
 */

"use client";

import { CornerBrackets, Input, Label } from "@elizaos/ui/cloud-ui";
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
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { isSafeNavigationUrl } from "../../lib/navigation-url";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  type BillingSnapshotV2View,
  useBillingSnapshotV2,
} from "../data/billing-snapshot";
import type { BillingCancelIntentCoordinator } from "../lib/billing-cancel-intent";
import {
  browserCardCheckoutIntentCoordinator,
  type CardCheckoutBindResult,
  CardCheckoutIntentCoordinationError,
  type CardCheckoutIntentCoordinator,
  type CardCheckoutIntentHandle,
} from "../lib/card-checkout-intent";
import { formatExactUsd } from "../lib/format-exact-usd";
import { useBillingResourceCancellations } from "../lib/use-billing-resource-cancellations";
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

import { Alert } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { SemanticForm } from "../../../components/ui/semantic-form";
import { Skeleton } from "../../../components/ui/skeleton";

interface BillingTabProps {
  user: BillingUser;
  checkoutIntentCoordinator?: CardCheckoutIntentCoordinator;
  billingCancellationCoordinator?: BillingCancelIntentCoordinator;
}

const AMOUNT_LIMITS = {
  MIN: 1,
  MAX: 10000,
} as const;

type PaymentMethod = "card" | "crypto";

const AMOUNT_HINT_ID = "purchase-amount-hint";
const AMOUNT_ERROR_ID = "purchase-amount-error";
const CARD_CHECKOUT_ERROR_ID = "card-checkout-error";

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
      <Skeleton
        role="status"
        aria-label={t("cloud.billing.compute.balanceLoading", {
          defaultValue: "Loading balance",
        })}
        className="inline-block h-12 w-44 max-w-full motion-reduce:animate-none"
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
    return { Icon: CheckCircle, className: "text-status-success" };
  }
  if (
    ["failed", "uncollectible", "void", "canceled", "cancelled"].includes(
      normalized,
    )
  ) {
    return { Icon: XCircle, className: "text-destructive" };
  }
  if (["pending", "open", "processing", "draft"].includes(normalized)) {
    return { Icon: Clock, className: "text-txt-strong" };
  }
  return { Icon: AlertCircle, className: "text-muted-strong" };
}

export function BillingTab({
  user,
  checkoutIntentCoordinator = browserCardCheckoutIntentCoordinator,
  billingCancellationCoordinator,
}: BillingTabProps) {
  const t = useCloudT();
  const navigate = useNavigate();
  const billingSnapshot = useBillingSnapshotV2(user.organization_id);
  const billingSnapshotState = toSnapshotViewState(billingSnapshot);
  const activeComputeResources =
    billingSnapshotState.kind === "ready" &&
    billingSnapshotState.snapshot.activeCompute.resources.status === "available"
      ? billingSnapshotState.snapshot.activeCompute.resources.value
      : null;
  const refetchBillingSnapshot = billingSnapshot.refetch;
  const handleCancellationTerminal = useCallback(async () => {
    return await refetchBillingSnapshot();
  }, [refetchBillingSnapshot]);
  const billingCancellations = useBillingResourceCancellations({
    organizationId: user.organization_id,
    initiatedByUserId: user.id,
    resources: activeComputeResources,
    coordinator: billingCancellationCoordinator,
    onTerminal: handleCancellationTerminal,
  });
  const [invoices, setInvoices] = useState<InvoiceDisplay[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(true);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [purchaseAmount, setPurchaseAmount] = useState("");

  // Tracks whether a submit has been attempted so an empty submission (which
  // never populates purchaseAmount) still marks the field invalid and renders
  // the adjacent inline error instead of only emitting a transient toast.
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [isProcessingCheckout, setIsProcessingCheckout] = useState(false);
  const [cardCheckoutError, setCardCheckoutError] = useState<string | null>(
    null,
  );
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  const [cryptoStatus, setCryptoStatus] = useState<CryptoStatusResponse | null>(
    null,
  );
  const activeCheckoutPrincipalRef = useRef<{
    organizationId: string;
    initiatedByUserId: string;
  } | null>(null);
  const checkoutAttemptRef = useRef(0);

  useLayoutEffect(() => {
    const principal = {
      organizationId: user.organization_id,
      initiatedByUserId: user.id,
    };
    activeCheckoutPrincipalRef.current = principal;
    setIsProcessingCheckout(false);
    setCardCheckoutError(null);

    return () => {
      if (activeCheckoutPrincipalRef.current === principal) {
        activeCheckoutPrincipalRef.current = null;
      }
      checkoutAttemptRef.current += 1;
    };
  }, [user.id, user.organization_id]);

  const fetchInvoices = useCallback(async () => {
    setLoadingInvoices(true);
    setInvoicesError(null);
    try {
      const data = await api<{ invoices?: InvoiceDisplay[] }>(
        "/api/invoices/list",
      );
      setInvoices(data.invoices ?? []);
    } catch (error) {
      // error-policy:J4 Invoice transport failure becomes a visible error state.
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
      // error-policy:J4 Optional crypto discovery degrades to the card-only UI.
      // Crypto is optional; absence just hides the crypto payment path.
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchInvoices();
      void fetchCryptoStatus();
    });
  }, [fetchInvoices, fetchCryptoStatus]);

  const describeCardCheckoutCoordinationFailure = (error: unknown) => {
    if (
      error instanceof CardCheckoutIntentCoordinationError &&
      error.code === "CARD_CHECKOUT_COORDINATION_STALE_AMOUNT_CONFLICT"
    ) {
      return t("cloud.billingTab.checkoutIntentAmountConflict", {
        defaultValue:
          "A previous checkout for another amount still needs reconciliation. Retry that amount, or contact support before starting a different checkout.",
      });
    }

    if (
      error instanceof CardCheckoutIntentCoordinationError &&
      error.code === "CARD_CHECKOUT_COORDINATION_SESSION_MISMATCH"
    ) {
      return t("cloud.billingTab.checkoutSessionConflict", {
        defaultValue:
          "Checkout returned conflicting sessions and was stopped. Do not retry payment; contact support.",
      });
    }

    if (
      error instanceof CardCheckoutIntentCoordinationError &&
      error.code === "CARD_CHECKOUT_COORDINATION_INVALID_INPUT"
    ) {
      return t("cloud.billingTab.checkoutCoordinationInvalid", {
        defaultValue:
          "Checkout returned invalid coordination data and was stopped. Try again; if this continues, contact support.",
      });
    }

    return t("cloud.billingTab.checkoutCoordinationUnavailable", {
      defaultValue:
        "Card checkout could not be coordinated safely. Try again; if this continues, update your browser or Android System WebView, or use another supported browser.",
    });
  };

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
        // error-policy:J4 Crypto checkout failure is surfaced through the UI toast boundary.
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

    // Card checkout only. The server uses exact whole cents in its request
    // digest, so reject anything it would reject before reserving an intent.
    const amountCents = amount * 100;
    if (!Number.isSafeInteger(amountCents)) {
      toast.error(
        t("cloud.billingTab.exactCentAmount", {
          defaultValue: "Amount must use exact whole cents",
        }),
      );
      setIsProcessingCheckout(false);
      return;
    }

    setCardCheckoutError(null);

    const checkoutAttempt = checkoutAttemptRef.current + 1;
    checkoutAttemptRef.current = checkoutAttempt;
    const checkoutPrincipal = {
      organizationId: user.organization_id,
      initiatedByUserId: user.id,
    };
    const isCurrentCheckoutAttempt = () => {
      const activePrincipal = activeCheckoutPrincipalRef.current;
      return (
        checkoutAttemptRef.current === checkoutAttempt &&
        activePrincipal?.organizationId === checkoutPrincipal.organizationId &&
        activePrincipal.initiatedByUserId ===
          checkoutPrincipal.initiatedByUserId
      );
    };

    // Membership refreshes deliberately unmount this surface. Never let a
    // response captured under an earlier user/org bind or navigate after that
    // authority has disappeared, and never let an older submit win locally.
    if (!isCurrentCheckoutAttempt()) {
      setIsProcessingCheckout(false);
      return;
    }

    // The durable coordinator owns one intent slot per organization and
    // serializes every mutation across tabs. It fails closed before the POST
    // if storage or Web Locks cannot provide that guarantee.
    let requestIntent: CardCheckoutIntentHandle;
    try {
      requestIntent = await checkoutIntentCoordinator.reserve({
        organizationId: checkoutPrincipal.organizationId,
        initiatedByUserId: checkoutPrincipal.initiatedByUserId,
        amountCents,
      });
    } catch (error) {
      // error-policy:J4 Coordination failure becomes a persistent checkout alert.
      if (!isCurrentCheckoutAttempt()) return;
      setCardCheckoutError(describeCardCheckoutCoordinationFailure(error));
      setIsProcessingCheckout(false);
      return;
    }

    if (!isCurrentCheckoutAttempt()) return;

    try {
      const data = await api<{ sessionId?: unknown; url?: unknown }>(
        "/api/stripe/create-checkout-session",
        {
          method: "POST",
          json: {
            amount,
            expectedOrganizationId: checkoutPrincipal.organizationId,
            expectedUserId: checkoutPrincipal.initiatedByUserId,
            returnUrl: "settings",
          },
          headers: { "Idempotency-Key": requestIntent.idempotencyKey },
        },
      );
      if (!isCurrentCheckoutAttempt()) return;
      if (typeof data.sessionId !== "string" || data.sessionId.length === 0) {
        toast.error(
          t("cloud.billingTab.noCheckoutSession", {
            defaultValue: "No checkout session returned",
          }),
        );
        setIsProcessingCheckout(false);
        return;
      }
      if (typeof data.url !== "string" || data.url.length === 0) {
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

      let binding: CardCheckoutBindResult;
      try {
        if (!isCurrentCheckoutAttempt()) return;
        binding = await checkoutIntentCoordinator.bindSession({
          organizationId: requestIntent.organizationId,
          initiatedByUserId: requestIntent.initiatedByUserId,
          amountCents: requestIntent.amountCents,
          idempotencyKey: requestIntent.idempotencyKey,
          sessionId: data.sessionId,
        });
      } catch (error) {
        // error-policy:J4 Binding failure becomes a persistent checkout alert.
        if (!isCurrentCheckoutAttempt()) return;
        setCardCheckoutError(describeCardCheckoutCoordinationFailure(error));
        setIsProcessingCheckout(false);
        return;
      }

      if (!isCurrentCheckoutAttempt()) return;

      if (binding.status === "superseded") {
        setCardCheckoutError(
          t("cloud.billingTab.checkoutIntentSuperseded", {
            defaultValue:
              "This checkout was superseded or already completed. Check the other tab before trying again.",
          }),
        );
        setIsProcessingCheckout(false);
        return;
      }

      // Keep the bound intent until this exact session verifies with
      // success:true. Redirects, cancellations, and back navigation are not
      // authoritative payment outcomes.
      if (!isCurrentCheckoutAttempt()) return;
      window.location.href = data.url;
    } catch (error) {
      // error-policy:J4 Checkout transport failures become visible retry guidance.
      if (!isCurrentCheckoutAttempt()) return;
      // Preserve the idempotency key across ambiguous outcomes: the server may
      // have created the durable order before the response was lost. Only an
      // exact 400 is definitive for this route; auth, conflict, throttling,
      // server, and transport failures all keep the key for safe replay.
      // Known edge: if the HTTP status was received but the response body
      // stream itself fails mid-read, the transport error escapes as a
      // non-ApiError — including after a 4xx. That case conservatively
      // PRESERVES the key: we cannot prove the server's 4xx semantics were
      // for this request, so treating it as ambiguous is the safe direction
      // (worst case, the retry hits the server's own key/digest conflict).
      if (error instanceof ApiError && error.status === 400) {
        try {
          await checkoutIntentCoordinator.clearDefinitiveRejection({
            organizationId: requestIntent.organizationId,
            initiatedByUserId: requestIntent.initiatedByUserId,
            amountCents: requestIntent.amountCents,
            idempotencyKey: requestIntent.idempotencyKey,
          });
        } catch (coordinationError) {
          // error-policy:J4 Failed exact cleanup becomes a persistent coordination alert.
          if (!isCurrentCheckoutAttempt()) return;
          setCardCheckoutError(
            describeCardCheckoutCoordinationFailure(coordinationError),
          );
        }
      }
      if (!isCurrentCheckoutAttempt()) return;
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
  const amountUsesExactCents =
    amountValue !== null && Number.isSafeInteger(amountValue * 100);
  const isValidAmount =
    amountValue !== null &&
    amountValue >= AMOUNT_LIMITS.MIN &&
    amountValue <= AMOUNT_LIMITS.MAX &&
    amountUsesExactCents;
  const showAmountError =
    (purchaseAmount.length > 0 || submitAttempted) && !isValidAmount;
  const amountDescribedBy = showAmountError
    ? `${AMOUNT_HINT_ID} ${AMOUNT_ERROR_ID}`
    : AMOUNT_HINT_ID;

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* Credit Balance Card */}
      <Card variant="brand" className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center gap-2">
            <Badge variant="mutedDot" />
            <h3 className="text-base font-mono text-txt uppercase">
              {t("cloud.billingTab.creditBalance", {
                defaultValue: "Credit Balance",
              })}
            </h3>
          </div>

          <div className="flex flex-col lg:flex-row gap-6 w-full">
            <div className="w-full lg:w-[400px] flex">
              <Card
                variant="brandSurface"
                className="flex flex-1 items-center justify-center py-6 lg:py-8"
              >
                <div className="flex flex-col items-center justify-center gap-1 px-4">
                  <div
                    aria-live="polite"
                    className="break-words text-center font-mono text-2xl tracking-tight text-txt-strong tabular-nums [overflow-wrap:anywhere] sm:text-[2.5rem]"
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
              </Card>
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
                      variant="choice"
                      type="button"
                      disabled={isProcessingCheckout}
                      onClick={() => {
                        setPaymentMethod("card");
                        setCardCheckoutError(null);
                      }}
                      aria-pressed={paymentMethod === "card"}
                      data-state={paymentMethod === "card" ? "on" : "off"}
                    >
                      <CreditCard className="size-4" />
                      {t("cloud.billingTab.card", { defaultValue: "Card" })}
                    </Button>
                    <Button
                      variant="choice"
                      type="button"
                      disabled={isProcessingCheckout}
                      onClick={() => {
                        setPaymentMethod("crypto");
                        setCardCheckoutError(null);
                      }}
                      aria-pressed={paymentMethod === "crypto"}
                      data-state={paymentMethod === "crypto" ? "on" : "off"}
                    >
                      <Wallet className="size-4" />
                      {t("cloud.billingTab.crypto", { defaultValue: "Crypto" })}
                    </Button>
                  </div>
                )}

                <SemanticForm
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
                          setCardCheckoutError(null);
                          if (submitAttempted) setSubmitAttempted(false);
                          // The durable intent is intentionally not cleared on
                          // each keystroke. The coordinator rotates atomically
                          // only when a complete different amount is submitted.
                        }}
                        variant="form"
                        density="relaxed"
                        adornment="leading"
                        className="font-mono tabular-nums"
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
                        className="mt-1.5 flex items-center gap-2 text-sm text-destructive"
                      >
                        <AlertCircle
                          className="size-4 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="font-mono">
                          {amountValue === null ||
                          amountValue < AMOUNT_LIMITS.MIN
                            ? t("cloud.billingTab.minAmount", {
                                min: AMOUNT_LIMITS.MIN,
                                defaultValue: "Minimum amount is $" + "{{min}}",
                              })
                            : amountValue > AMOUNT_LIMITS.MAX
                              ? t("cloud.billingTab.maxAmount", {
                                  max: AMOUNT_LIMITS.MAX,
                                  defaultValue:
                                    "Maximum amount is $" + "{{max}}",
                                })
                              : t("cloud.billingTab.exactCentAmount", {
                                  defaultValue:
                                    "Amount must use exact whole cents",
                                })}
                        </span>
                      </div>
                    )}
                  </div>

                  {(paymentMethod !== "crypto" ||
                    !cryptoStatus?.directWallet?.enabled) && (
                    <Button
                      type="submit"
                      variant={isProcessingCheckout ? "outline" : "default"}
                      disabled={isProcessingCheckout}
                      className="h-11 px-6 w-full sm:w-auto shrink-0 font-mono text-base whitespace-nowrap sm:mt-[26px]"
                    >
                      {isProcessingCheckout ? (
                        <>
                          <Loader2
                            className="size-4 animate-spin"
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
                    </Button>
                  )}
                </SemanticForm>

                {cardCheckoutError ? (
                  <Alert
                    variant="dashboardError"
                    id={CARD_CHECKOUT_ERROR_ID}
                    role="alert"
                    aria-live="assertive"
                    className="flex max-w-2xl items-start gap-2"
                  >
                    <AlertCircle
                      className="mt-0.5 size-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="font-mono">{cardCheckoutError}</span>
                  </Alert>
                ) : null}

                {isValidAmount && purchaseAmount && amountValue !== null && (
                  <div className="flex items-center gap-2 text-sm text-status-success">
                    <CheckCircle className="size-4" />
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
      </Card>

      <ActiveComputeCardView
        state={billingSnapshotState}
        cancellationAuthorityKey={`${user.organization_id}:${user.id}`}
        cancellationStates={billingCancellations.states}
        onRequestCancellation={(resource) => {
          void billingCancellations.request(resource);
        }}
        onCheckCancellationReceipt={(resource) => {
          void billingCancellations.checkReceipt(resource);
        }}
        onRetry={() => {
          void billingSnapshot.refetch();
        }}
      />

      {/* Card auto top-up keeps the consumer billing path explicit and visible. */}
      <AutoTopUpCard />

      {/* Invoices Card */}
      <Card variant="brand" className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Badge variant="mutedDot" />
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
              <Card variant="brandSurface" className="flex-[1.5] p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colDateTime", {
                    defaultValue: "Date & Time",
                  })}
                </p>
              </Card>
              <Card variant="brandSurface" className="flex-1 p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colTotal", { defaultValue: "Total" })}
                </p>
              </Card>
              <Card variant="brandSurface" className="flex-1 p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colStatus", {
                    defaultValue: "Status",
                  })}
                </p>
              </Card>
              <Card variant="brandSurface" className="flex-1 p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colActions", {
                    defaultValue: "Actions",
                  })}
                </p>
              </Card>
            </div>

            {loadingInvoices ? (
              <Card
                variant="brandSurface"
                surface="card"
                className="flex items-center justify-center p-8"
              >
                <Loader2 className="size-6 animate-spin text-muted" />
              </Card>
            ) : invoicesError ? (
              <Card
                surface="destructiveSubtle"
                border="standard"
                className="flex items-start gap-3 p-8"
              >
                <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                <div className="space-y-1">
                  <p className="text-xs md:text-sm text-destructive font-mono">
                    {t("cloud.billingTab.invoiceLoadFailed", {
                      defaultValue: "Invoice history could not be loaded",
                    })}
                  </p>
                  <p className="text-xs text-muted-strong font-mono">
                    {invoicesError}
                  </p>
                </div>
              </Card>
            ) : invoices.length === 0 ? (
              <Card
                variant="brandSurface"
                surface="card"
                className="flex items-center justify-center p-8"
              >
                <p className="text-xs md:text-sm text-muted-strong font-mono">
                  {t("cloud.billingTab.noInvoices", {
                    defaultValue: "No invoices yet",
                  })}
                </p>
              </Card>
            ) : (
              invoices.map((invoice) => {
                const { Icon: StatusIcon, className: statusClassName } =
                  getInvoiceStatusPresentation(invoice.status);
                return (
                  <Card
                    variant="brandSurface"
                    surface="card"
                    key={invoice.id}
                    data-testid="invoice-row"
                    className="flex w-full flex-col sm:flex-row"
                  >
                    <Card
                      surface="transparent"
                      radius="none"
                      className="flex flex-[1.5] items-center justify-between gap-3 p-3 md:p-4"
                    >
                      <span className="sm:hidden text-xs font-mono font-bold uppercase text-muted-strong">
                        {t("cloud.billingTab.colDateTime", {
                          defaultValue: "Date & Time",
                        })}
                      </span>
                      <p className="text-xs md:text-sm font-mono text-txt-strong tabular-nums text-right sm:text-left">
                        {invoice.date}
                      </p>
                    </Card>
                    <Card
                      variant="brandSurface"
                      surface="transparent"
                      className="flex flex-1 items-center justify-between gap-3 p-3 md:p-4"
                    >
                      <span className="sm:hidden text-xs font-mono font-bold uppercase text-muted-strong">
                        {t("cloud.billingTab.colTotal", {
                          defaultValue: "Total",
                        })}
                      </span>
                      <p className="text-xs md:text-sm font-mono text-txt-strong uppercase tabular-nums">
                        {invoice.total}
                      </p>
                    </Card>
                    <Card
                      variant="brandSurface"
                      surface="transparent"
                      className="flex flex-1 items-center justify-between gap-3 p-3 md:p-4"
                    >
                      <span className="sm:hidden text-xs font-mono font-bold uppercase text-muted-strong">
                        {t("cloud.billingTab.colStatus", {
                          defaultValue: "Status",
                        })}
                      </span>
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs md:text-sm font-mono uppercase ${statusClassName}`}
                      >
                        <StatusIcon
                          className="size-4 shrink-0"
                          aria-hidden={true}
                        />
                        <span>{invoice.status}</span>
                      </span>
                    </Card>
                    <Card
                      surface="transparent"
                      radius="none"
                      className="flex flex-1 items-center justify-between gap-3 p-3 md:p-4"
                    >
                      <span className="sm:hidden text-xs font-mono font-bold uppercase text-muted-strong">
                        {t("cloud.billingTab.colActions", {
                          defaultValue: "Actions",
                        })}
                      </span>
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => handleViewInvoice(invoice)}
                      >
                        {t("cloud.billingTab.view", { defaultValue: "View" })}
                      </Button>
                    </Card>
                  </Card>
                );
              })
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

export type { BillingUser };
