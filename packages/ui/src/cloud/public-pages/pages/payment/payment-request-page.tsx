/**
 * Hosted public page for a payment request.
 *
 * Reads the redacted public view from /api/v1/payment-requests/:id?public=1 and
 * presents a single "Pay" button that delegates to the provider's checkout.
 * Renders WITHOUT the app shell chrome.
 */

import type {
  PaymentProvider,
  PublicPaymentRequest,
} from "@elizaos/cloud-shared/lib/services/payment-requests";
import { AlertCircle, CreditCard, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Button } from "../../../../components/ui/button";
import { ApiError, api } from "../../../lib/api-client";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

type TFn = ReturnType<typeof useCloudT>;

interface PaymentRequestPageProps {
  navigateToCheckout?: (url: string) => void;
}

interface PublicResponse {
  success: boolean;
  paymentRequest: PublicPaymentRequest;
}

const PROVIDER_LABELS: Record<PaymentProvider, string> = {
  stripe: "Stripe",
  oxapay: "OxaPay",
  x402: "x402",
  wallet_native: "Wallet",
};

function paymentRequestPath(id: string): string {
  return `/api/v1/payment-requests/${encodeURIComponent(id)}?public=1`;
}

function expiryTime(value: string | null): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function isPayable(request: PublicPaymentRequest, now: number): boolean {
  const expiresAt = expiryTime(request.expiresAt);
  return (
    (request.status === "pending" || request.status === "delivered") &&
    Boolean(request.hostedUrl) &&
    expiresAt !== null &&
    expiresAt > now
  );
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "AbortError"
  );
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

function formatDate(value: string | null): string | null {
  const timestamp = expiryTime(value);
  if (timestamp === null) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function normalizeError(error: unknown, t: TFn): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return t("cloud.paymentRequest.unableToLoad", {
    defaultValue: "Unable to load payment request.",
  });
}

export function PaymentRequestPageView({
  navigateToCheckout = (url) => window.location.assign(url),
}: PaymentRequestPageProps) {
  const t = useCloudT();
  const { paymentRequestId } = useParams<{ paymentRequestId: string }>();
  const [paymentRequest, setPaymentRequest] =
    useState<PublicPaymentRequest | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [now, setNow] = useState(0);
  const generationRef = useRef(0);
  const checkoutAbortRef = useRef<AbortController | null>(null);

  usePageTitle(
    t("cloud.paymentRequest.metaTitle", {
      defaultValue: "Payment Request | Eliza Cloud",
    }),
  );

  useEffect(() => {
    const generation = ++generationRef.current;
    const controller = new AbortController();
    checkoutAbortRef.current?.abort();
    checkoutAbortRef.current = null;
    setPaymentRequest(null);
    setIsPaying(false);

    if (!paymentRequestId) {
      setError(
        t("cloud.paymentRequest.missingId", {
          defaultValue: "Missing payment request id.",
        }),
      );
      setIsLoading(false);
      return () => controller.abort();
    }

    setIsLoading(true);
    setError(null);

    void (async () => {
      try {
        const response = await api<PublicResponse>(
          paymentRequestPath(paymentRequestId),
          { skipAuth: true, signal: controller.signal },
        );
        if (generationRef.current !== generation) return;
        setPaymentRequest(response.paymentRequest);
        setNow(Date.now());
      } catch (loadError) {
        if (generationRef.current !== generation || isAbortError(loadError)) {
          return;
        }
        setError(normalizeError(loadError, t));
      } finally {
        if (generationRef.current === generation) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      controller.abort();
      checkoutAbortRef.current?.abort();
      checkoutAbortRef.current = null;
      if (generationRef.current === generation) {
        generationRef.current += 1;
      }
    };
  }, [paymentRequestId, t]);

  useEffect(() => {
    const deadline = expiryTime(paymentRequest?.expiresAt ?? null);
    if (deadline === null) return;

    let timer: number | undefined;
    const scheduleDeadline = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setNow(Date.now());
        return;
      }
      timer = window.setTimeout(
        scheduleDeadline,
        Math.min(remaining, 2_147_483_647),
      );
    };
    scheduleDeadline();
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [paymentRequest?.expiresAt]);

  const beginCheckout = async () => {
    if (!paymentRequest || !paymentRequestId) return;
    if (!isPayable(paymentRequest, Date.now())) {
      setError(
        t("cloud.paymentRequest.noLongerPayable", {
          defaultValue: "This payment request is no longer payable.",
        }),
      );
      return;
    }

    const generation = generationRef.current;
    const controller = new AbortController();
    checkoutAbortRef.current?.abort();
    checkoutAbortRef.current = controller;
    setIsPaying(true);
    setError(null);

    try {
      const response = await api<PublicResponse>(
        paymentRequestPath(paymentRequestId),
        { skipAuth: true, signal: controller.signal },
      );
      if (generationRef.current !== generation || controller.signal.aborted) {
        return;
      }

      const authoritative = response.paymentRequest;
      const currentTime = Date.now();
      if (
        authoritative.id !== paymentRequestId ||
        !isPayable(authoritative, currentTime) ||
        !authoritative.hostedUrl
      ) {
        setPaymentRequest(authoritative);
        setNow(currentTime);
        setError(
          t("cloud.paymentRequest.noLongerPayable", {
            defaultValue: "This payment request is no longer payable.",
          }),
        );
        return;
      }

      setPaymentRequest(authoritative);
      setNow(currentTime);
      navigateToCheckout(authoritative.hostedUrl);
    } catch (checkoutError) {
      if (generationRef.current !== generation || isAbortError(checkoutError)) {
        return;
      }
      setError(normalizeError(checkoutError, t));
    } finally {
      if (generationRef.current === generation) {
        setIsPaying(false);
      }
    }
  };

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
                {error ||
                  t("cloud.paymentRequest.linkUnavailable", {
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
  const deadline = expiryTime(paymentRequest.expiresAt);
  const isPastDeadline = deadline === null || deadline <= now;
  const isExpired =
    paymentRequest.status === "expired" ||
    paymentRequest.status === "canceled" ||
    paymentRequest.status === "failed" ||
    isPastDeadline;
  const canPay = isPayable(paymentRequest, now);
  const expiresLabel = formatDate(paymentRequest.expiresAt);
  const shortId = paymentRequest.id.slice(0, 8);
  const providerLabel = PROVIDER_LABELS[paymentRequest.provider];

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

          {error && (
            <div className="mt-7 flex items-center gap-3 border border-destructive/30 bg-destructive-subtle p-3 text-sm text-txt">
              <AlertCircle className="h-5 w-5 shrink-0 text-destructive" />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-8">
            <Button
              variant="ghost"
              type="button"
              disabled={!canPay || isPaying}
              onClick={() => void beginCheckout()}
              className="flex w-full items-center justify-center gap-3 bg-accent-subtle px-4 py-4 text-txt transition hover:bg-bg-hover disabled:pointer-events-none disabled:opacity-30"
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
                      provider: providerLabel,
                      defaultValue: "Pay with {{provider}}",
                    })}
              </span>
            </Button>
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-border pt-4 text-xs text-muted">
            <span>#{shortId}</span>
            <span>{providerLabel}</span>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function PaymentRequestPage() {
  return <PaymentRequestPageView />;
}
