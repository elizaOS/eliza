/**
 * Hosted public page for a payment request.
 *
 * Reads the redacted public view from /api/v1/payment-requests/:id?public=1 and
 * presents a single "Pay" button that delegates to the provider's checkout.
 * Renders WITHOUT the app shell chrome.
 *
 * Loads are generation-keyed and aborted on route change so an out-of-order
 * response for a previous request id can never overwrite the current route's
 * amount, status, or checkout destination. Pay eligibility is derived from
 * both status and the request deadline, re-evaluated as the deadline passes,
 * and revalidated against the server immediately before checkout navigation.
 */

import { AlertCircle, CreditCard, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../../../../components/ui/button";
import { ApiError, api } from "../../../lib/api-client";
import { isSafeNavigationUrl } from "../../../lib/navigation-url";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

type TFn = ReturnType<typeof useCloudT>;

type PaymentProvider = "stripe" | "oxapay" | "x402" | "wallet_native";
type PaymentRequestStatus =
  | "pending"
  | "delivered"
  | "settled"
  | "expired"
  | "canceled"
  | "failed";

interface PublicPaymentRequest {
  id: string;
  provider: PaymentProvider;
  amountCents: number;
  currency: string;
  status: PaymentRequestStatus;
  reason: string | null;
  expiresAt: string | null;
  hostedUrl: string | null;
}

interface PublicResponse {
  success: boolean;
  paymentRequest: PublicPaymentRequest;
}

/** User-facing names for provider storage identifiers; raw enum values never render. */
const PROVIDER_LABELS: Record<
  PaymentProvider,
  { key: string; defaultValue: string }
> = {
  stripe: {
    key: "cloud.paymentRequest.provider.stripe",
    defaultValue: "Stripe",
  },
  oxapay: {
    key: "cloud.paymentRequest.provider.oxapay",
    defaultValue: "OxaPay",
  },
  x402: { key: "cloud.paymentRequest.provider.x402", defaultValue: "x402" },
  wallet_native: {
    key: "cloud.paymentRequest.provider.walletNative",
    defaultValue: "Wallet",
  },
};

function providerLabel(provider: PaymentProvider, t: TFn): string {
  const entry = PROVIDER_LABELS[provider];
  if (!entry) return String(provider);
  return t(entry.key, { defaultValue: entry.defaultValue });
}

function formatAmount(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

type Deadline =
  | { kind: "none" }
  | { kind: "invalid" }
  | { kind: "valid"; valueMs: number };

const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/** Parses the server deadline without turning malformed input into a payable request. */
function parseDeadline(value: string | null): Deadline {
  if (value === null) return { kind: "none" };
  const valueMs = Date.parse(value);
  return Number.isFinite(valueMs)
    ? { kind: "valid", valueMs }
    : { kind: "invalid" };
}

function formatDeadline(deadline: Deadline): string | null {
  if (deadline.kind !== "valid") return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(deadline.valueMs));
}

function isDeadlinePassed(deadline: Deadline, nowMs: number): boolean {
  return deadline.kind === "valid" && deadline.valueMs <= nowMs;
}

function isPayableStatus(status: PaymentRequestStatus): boolean {
  return status === "pending" || status === "delivered";
}

/**
 * Raw page-error state; the user-facing message is derived at render time so
 * effects never need the (render-scoped) translator in their dependency list.
 */
type PageError =
  | { kind: "request-failed"; cause: unknown }
  | { kind: "no-checkout-url" }
  | { kind: "invalid-checkout-url" }
  | { kind: "invalid-deadline" };

function errorMessage(error: PageError, t: TFn): string {
  if (error.kind === "invalid-deadline") {
    return t("cloud.paymentRequest.invalidExpiry", {
      defaultValue:
        "This payment request has an invalid expiry date and cannot be paid.",
    });
  }
  if (error.kind === "no-checkout-url") {
    return t("cloud.paymentRequest.noCheckoutUrl", {
      defaultValue: "This payment request has no hosted checkout URL yet.",
    });
  }
  if (error.kind === "invalid-checkout-url") {
    return t("cloud.paymentRequest.invalidCheckoutUrl", {
      defaultValue: "This payment request's checkout URL is not valid.",
    });
  }
  const { cause } = error;
  if (cause instanceof ApiError) return cause.message;
  if (cause instanceof Error) return cause.message;
  return t("cloud.paymentRequest.unableToLoad", {
    defaultValue: "Unable to load payment request.",
  });
}

export default function PaymentRequestPage() {
  const t = useCloudT();
  const { paymentRequestId } = useParams<{ paymentRequestId: string }>();
  const [paymentRequest, setPaymentRequest] =
    useState<PublicPaymentRequest | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<PageError | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [nowMs, setNowMs] = useState<number | null>(null);
  // Monotonic key: only the latest load (or a checkout revalidation started
  // under it) may commit state, so stale responses cannot cross routes.
  const loadGenerationRef = useRef(0);

  usePageTitle(
    t("cloud.paymentRequest.metaTitle", {
      defaultValue: "Payment Request | Eliza Cloud",
    }),
  );

  const fetchPublicRequest = useCallback(
    (id: string, signal?: AbortSignal) =>
      api<PublicResponse>(
        `/api/v1/payment-requests/${encodeURIComponent(id)}?public=1`,
        { skipAuth: true, signal },
      ),
    [],
  );

  useEffect(() => {
    const generation = ++loadGenerationRef.current;
    if (!paymentRequestId) {
      setPaymentRequest(null);
      setIsLoading(false);
      return;
    }
    const controller = new AbortController();
    setPaymentRequest(null);
    setIsLoading(true);
    setError(null);
    setIsPaying(false);
    (async () => {
      try {
        const response = await fetchPublicRequest(
          paymentRequestId,
          controller.signal,
        );
        if (loadGenerationRef.current !== generation) return;
        setPaymentRequest(response.paymentRequest);
        setNowMs(Date.now());
      } catch (loadError) {
        // error-policy:J4 — an aborted or superseded load is not this route's
        // failure; only the current generation surfaces a visible error state.
        if (
          controller.signal.aborted ||
          loadGenerationRef.current !== generation
        ) {
          return;
        }
        setError({ kind: "request-failed", cause: loadError });
      } finally {
        if (
          !controller.signal.aborted &&
          loadGenerationRef.current === generation
        ) {
          setIsLoading(false);
        }
      }
    })();
    return () => {
      controller.abort();
      // Route replacement increments this again in the next effect. A plain
      // unmount has no next effect, so invalidate the generation here as well
      // to prevent an in-flight checkout revalidation from navigating after
      // the user has already left this page.
      if (loadGenerationRef.current === generation) {
        loadGenerationRef.current += 1;
      }
    };
  }, [paymentRequestId, fetchPublicRequest]);

  // Re-evaluate eligibility exactly when the deadline passes so an open tab
  // cannot keep a stale enabled Pay button across the request's expiry.
  const expiresAt = paymentRequest?.expiresAt ?? null;
  useEffect(() => {
    const deadline = parseDeadline(expiresAt);
    if (deadline.kind !== "valid") return;

    let timer: number | undefined;
    const armTimer = () => {
      const remainingMs = deadline.valueMs - Date.now();
      if (remainingMs <= 0) {
        setNowMs(Date.now());
        return;
      }
      // Browser timers cannot represent delays above 2^31-1 ms. Wake at that
      // boundary and re-arm until the actual deadline rather than expiring early.
      timer = window.setTimeout(
        armTimer,
        Math.min(remainingMs + 1, MAX_TIMER_DELAY_MS),
      );
    };

    armTimer();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [expiresAt]);

  const beginCheckout = useCallback(async () => {
    if (!paymentRequest || !paymentRequestId || isPaying) return;
    setIsPaying(true);
    setError(null);
    const generation = loadGenerationRef.current;
    try {
      // Revalidate against the server immediately before navigation: the
      // request may have settled, been canceled, or expired since page load.
      const response = await fetchPublicRequest(paymentRequestId);
      if (loadGenerationRef.current !== generation) return;
      const fresh = response.paymentRequest;
      const freshNow = Date.now();
      setPaymentRequest(fresh);
      setNowMs(freshNow);
      const freshDeadline = parseDeadline(fresh.expiresAt);
      const payable =
        isPayableStatus(fresh.status) &&
        freshDeadline.kind !== "invalid" &&
        !isDeadlinePassed(freshDeadline, freshNow);
      if (!payable) {
        setIsPaying(false);
        return;
      }
      if (!fresh.hostedUrl) {
        setIsPaying(false);
        setError({ kind: "no-checkout-url" });
        return;
      }
      if (!isSafeNavigationUrl(fresh.hostedUrl)) {
        // The hosted checkout URL is a wire value assigned to the top window
        // on a public, unauthenticated page — only absolute http(s) may
        // navigate; anything else is the visible error state.
        setIsPaying(false);
        setError({ kind: "invalid-checkout-url" });
        return;
      }
      window.location.assign(fresh.hostedUrl);
    } catch (checkoutError) {
      // error-policy:J4 — a failed pre-checkout revalidation blocks navigation
      // and is rendered as a visible page error, never a silent redirect.
      if (loadGenerationRef.current !== generation) return;
      setIsPaying(false);
      setError({ kind: "request-failed", cause: checkoutError });
    }
  }, [paymentRequest, paymentRequestId, isPaying, fetchPublicRequest]);

  if (isLoading) {
    return (
      <div className="theme-cloud flex min-h-[100dvh] items-center justify-center bg-bg p-4">
        <Loader2 className="h-8 w-8 animate-spin text-muted" />
      </div>
    );
  }

  if (!paymentRequest) {
    return (
      <div className="theme-cloud flex min-h-[100dvh] items-center justify-center bg-bg p-4 text-txt">
        <div className="w-full max-w-sm border border-destructive/30 bg-destructive-subtle p-5">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-6 w-6 text-destructive" />
            <div>
              <h1 className="text-base font-semibold">
                {t("cloud.paymentRequest.unavailableTitle", {
                  defaultValue: "Payment request unavailable",
                })}
              </h1>
              <p className="mt-1 text-sm text-muted">
                {!paymentRequestId
                  ? t("cloud.paymentRequest.missingId", {
                      defaultValue: "Missing payment request id.",
                    })
                  : error
                    ? errorMessage(error, t)
                    : t("cloud.paymentRequest.linkUnavailable", {
                        defaultValue: "This payment link is unavailable.",
                      })}
              </p>
            </div>
          </div>
          <Link
            className="mt-5 inline-flex text-sm text-muted hover:text-txt"
            to="/"
          >
            {t("cloud.paymentRequest.returnHome", {
              defaultValue: "Return home",
            })}
          </Link>
        </div>
      </div>
    );
  }

  const isPaid = paymentRequest.status === "settled";
  const deadline = parseDeadline(paymentRequest.expiresAt);
  // Loading the request and capturing its comparison timestamp happen at the
  // same effect boundary. Fail closed if they ever become temporarily split.
  const deadlinePassed = nowMs === null || isDeadlinePassed(deadline, nowMs);
  const hasInvalidPayableDeadline =
    isPayableStatus(paymentRequest.status) && deadline.kind === "invalid";
  const isExpired =
    paymentRequest.status === "expired" ||
    paymentRequest.status === "canceled" ||
    paymentRequest.status === "failed" ||
    (isPayableStatus(paymentRequest.status) && deadlinePassed);
  const canPay =
    isPayableStatus(paymentRequest.status) &&
    !hasInvalidPayableDeadline &&
    !deadlinePassed &&
    Boolean(paymentRequest.hostedUrl);
  const expiresLabel = formatDeadline(deadline);
  const shortId = paymentRequest.id.slice(0, 8);
  const provider = providerLabel(paymentRequest.provider, t);
  const displayedError: PageError | null = hasInvalidPayableDeadline
    ? { kind: "invalid-deadline" }
    : error;

  return (
    <div className="theme-cloud min-h-[100dvh] bg-bg px-4 py-8 text-txt sm:px-6 lg:px-8">
      <main
        id="main"
        className="mx-auto flex min-h-[calc(100dvh-4rem)] w-full max-w-xl items-center"
      >
        <section className="w-full border border-border bg-surface p-5 sm:p-7">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center border border-accent/30 bg-accent-subtle">
              <CreditCard className="h-7 w-7 text-accent" />
            </div>
            <div className="mt-5 text-5xl font-semibold leading-none sm:text-6xl">
              {formatAmount(
                paymentRequest.amountCents,
                paymentRequest.currency,
              )}
            </div>
            <div className="mt-3 text-sm text-muted">
              {isPaid
                ? t("cloud.paymentRequest.paid", { defaultValue: "Paid" })
                : hasInvalidPayableDeadline
                  ? t("cloud.paymentRequest.invalidExpiryShort", {
                      defaultValue: "Invalid expiry date",
                    })
                  : isExpired
                    ? paymentRequest.status === "canceled"
                      ? t("cloud.paymentRequest.cancelled", {
                          defaultValue: "Cancelled",
                        })
                      : paymentRequest.status === "failed"
                        ? t("cloud.paymentRequest.failed", {
                            defaultValue: "Failed",
                          })
                        : t("cloud.paymentRequest.expired", {
                            defaultValue: "Expired",
                          })
                    : expiresLabel
                      ? t("cloud.paymentRequest.pendingExpires", {
                          date: expiresLabel,
                          defaultValue: "Pending - expires {{date}}",
                        })
                      : t("cloud.paymentRequest.pending", {
                          defaultValue: "Pending",
                        })}
            </div>
            {paymentRequest.reason && (
              <p className="mt-3 max-w-md text-sm text-muted-strong">
                {paymentRequest.reason}
              </p>
            )}
          </div>

          {displayedError && (
            <div className="mt-7 flex items-center gap-3 border border-destructive/30 bg-destructive-subtle p-3 text-sm text-txt">
              <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
              <span>{errorMessage(displayedError, t)}</span>
            </div>
          )}

          <div className="mt-8">
            <Button
              variant="surfaceAccent"
              type="button"
              disabled={!canPay || isPaying}
              onClick={beginCheckout}
              className="flex w-full items-center justify-center gap-3 px-4 py-4 transition disabled:pointer-events-none disabled:opacity-30"
            >
              {isPaying ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <CreditCard className="h-5 w-5" />
              )}
              <span className="text-sm font-medium">
                {isPaid
                  ? t("cloud.paymentRequest.alreadyPaid", {
                      defaultValue: "Already paid",
                    })
                  : t("cloud.paymentRequest.payWith", {
                      provider,
                      defaultValue: "Pay with {{provider}}",
                    })}
              </span>
            </Button>
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-border pt-4 text-xs text-muted">
            <span>#{shortId}</span>
            <span>{provider}</span>
          </div>
        </section>
      </main>
    </div>
  );
}
