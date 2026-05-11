/**
 * Hosted public page for a unified payment request.
 *
 * Reads the redacted public view from /api/v1/payment-requests/:id?public=1
 * and presents a single "Pay" button that delegates to the provider's
 * checkout (e.g. for stripe, redirects to the hostedUrl returned by the
 * underlying provider session).
 */

import { AlertCircle, CreditCard, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, api } from "../../../lib/api-client";

type PaymentProvider = "stripe" | "oxapay" | "x402" | "crypto";
type PaymentContext = "verified_payer" | "any_payer";
type PaymentRequestStatus =
  | "pending"
  | "settled"
  | "expired"
  | "cancelled"
  | "failed";

interface PublicPaymentRequest {
  id: string;
  organizationId: string;
  agentId: string | null;
  provider: PaymentProvider;
  amountCents: number;
  currency: string;
  paymentContext: PaymentContext;
  status: PaymentRequestStatus;
  reason: string | null;
  expiresAt: string | null;
  callbackUrl: string | null;
  payerIdentityId: string | null;
  settlementTxRef: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  hostedUrl?: string;
}

interface PublicResponse {
  success: boolean;
  paymentRequest: PublicPaymentRequest;
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
  if (!value) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function normalizeError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unable to load payment request.";
}

export default function PaymentRequestPage() {
  const { paymentRequestId } = useParams<{ paymentRequestId: string }>();
  const [paymentRequest, setPaymentRequest] = useState<PublicPaymentRequest | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPaying, setIsPaying] = useState(false);

  const load = useCallback(async () => {
    if (!paymentRequestId) {
      setError("Missing payment request id.");
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const response = await api<PublicResponse>(
        `/api/v1/payment-requests/${encodeURIComponent(paymentRequestId)}?public=1`,
        { skipAuth: true },
      );
      setPaymentRequest(response.paymentRequest);
    } catch (loadError) {
      setError(normalizeError(loadError));
    } finally {
      setIsLoading(false);
    }
  }, [paymentRequestId]);

  useEffect(() => {
    load();
  }, [load]);

  const beginCheckout = () => {
    if (!paymentRequest) return;
    const url = paymentRequest.hostedUrl;
    if (!url) {
      setError("This payment request has no hosted checkout URL yet.");
      return;
    }
    setIsPaying(true);
    window.location.assign(url);
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#080A0D] p-4">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-200/70" />
      </div>
    );
  }

  if (!paymentRequest) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#080A0D] p-4 text-white">
        <div className="w-full max-w-sm border border-red-400/30 bg-red-500/10 p-5">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-6 w-6 text-red-300" />
            <div>
              <h1 className="text-base font-semibold">Payment request unavailable</h1>
              <p className="mt-1 text-sm text-red-100/75">
                {error || "This payment link is unavailable."}
              </p>
            </div>
          </div>
          <Link className="mt-5 inline-flex text-sm text-cyan-200 hover:text-cyan-100" to="/">
            Return home
          </Link>
        </div>
      </div>
    );
  }

  const isPaid = paymentRequest.status === "settled";
  const isExpired =
    paymentRequest.status === "expired" ||
    paymentRequest.status === "cancelled" ||
    paymentRequest.status === "failed";
  const canPay = paymentRequest.status === "pending" && Boolean(paymentRequest.hostedUrl);
  const expiresLabel = formatDate(paymentRequest.expiresAt);
  const shortId = paymentRequest.id.slice(0, 8);

  return (
    <div className="min-h-screen bg-[#080A0D] px-4 py-8 text-white sm:px-6 lg:px-8">
      <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-xl items-center">
        <section className="w-full border border-white/10 bg-white/[0.03] p-5 shadow-2xl shadow-black/30 sm:p-7">
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center border border-cyan-300/30 bg-cyan-400/10">
              <CreditCard className="h-7 w-7 text-cyan-200" />
            </div>
            <div className="mt-5 text-5xl font-semibold leading-none sm:text-6xl">
              {formatAmount(paymentRequest.amountCents, paymentRequest.currency)}
            </div>
            <div className="mt-3 text-sm text-white/55">
              {isPaid
                ? "Paid"
                : isExpired
                  ? paymentRequest.status === "cancelled"
                    ? "Cancelled"
                    : paymentRequest.status === "failed"
                      ? "Failed"
                      : "Expired"
                  : expiresLabel
                    ? `Pending - expires ${expiresLabel}`
                    : "Pending"}
            </div>
            {paymentRequest.reason && (
              <p className="mt-3 max-w-md text-sm text-white/65">{paymentRequest.reason}</p>
            )}
          </div>

          {error && (
            <div className="mt-7 flex items-center gap-3 border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
              <AlertCircle className="h-5 w-5 shrink-0 text-red-300" />
              <span>{error}</span>
            </div>
          )}

          <div className="mt-8">
            <button
              type="button"
              disabled={!canPay || isPaying}
              onClick={beginCheckout}
              className="flex w-full items-center justify-center gap-3 border border-amber-300/30 bg-amber-400/10 px-4 py-4 text-amber-100 transition hover:border-amber-200/60 hover:bg-amber-300/15 disabled:pointer-events-none disabled:opacity-30"
            >
              {isPaying ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <CreditCard className="h-5 w-5" />
              )}
              <span className="text-sm font-medium">
                {isPaid ? "Already paid" : `Pay with ${paymentRequest.provider}`}
              </span>
            </button>
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-white/10 pt-4 text-xs text-white/35">
            <span>#{shortId}</span>
            <span>{paymentRequest.provider}</span>
          </div>
        </section>
      </main>
    </div>
  );
}
