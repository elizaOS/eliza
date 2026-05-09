import { AlertCircle, CheckCircle2, Coins, CreditCard, Loader2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { ApiError, api } from "../../../../../lib/api-client";

type AppChargeProvider = "stripe" | "oxapay";

interface AppChargeRequest {
  id: string;
  appId: string;
  amountUsd: number;
  description: string | null;
  providers: AppChargeProvider[];
  paymentUrl: string;
  status: string;
  paidAt: string | null;
  paidProvider?: AppChargeProvider;
  providerPaymentId?: string;
  expiresAt: string;
  createdAt: string;
}

interface AppChargeDetails {
  charge: AppChargeRequest;
  app: {
    id: string;
    name: string;
    description: string | null;
    logo_url: string | null;
    website_url: string | null;
  };
}

type CheckoutResponse =
  | {
      checkout: {
        provider: "stripe";
        url: string | null;
        sessionId: string;
      };
    }
  | {
      checkout: {
        provider: "oxapay";
        paymentId: string;
        trackId: string;
        payLink: string;
        expiresAt: string;
      };
    };

function formatAmount(amount: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(amount);
}

function formatDate(value: string): string {
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
  return "Unable to complete the request.";
}

export default function AppChargePaymentPage() {
  const { appId, chargeId } = useParams<{ appId: string; chargeId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const { ready, authenticated } = useSessionAuth();

  const [details, setDetails] = useState<AppChargeDetails | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checkoutProvider, setCheckoutProvider] = useState<AppChargeProvider | null>(null);
  const [confirmationPolls, setConfirmationPolls] = useState(0);

  const loadCharge = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!appId || !chargeId) {
        setError("Missing charge link details.");
        setIsLoading(false);
        return;
      }

      if (!options?.silent) {
        setIsLoading(true);
      }
      setError(null);
      try {
        const response = await api<AppChargeDetails>(
          `/api/v1/apps/${encodeURIComponent(appId)}/charges/${encodeURIComponent(chargeId)}`,
          { skipAuth: true },
        );
        setDetails(response);
      } catch (loadError) {
        setError(normalizeError(loadError));
      } finally {
        if (!options?.silent) {
          setIsLoading(false);
        }
      }
    },
    [appId, chargeId],
  );

  useEffect(() => {
    loadCharge();
  }, [loadCharge]);

  const charge = details?.charge;
  const enabledProviders = useMemo(() => new Set(charge?.providers ?? []), [charge?.providers]);
  const returnedFromPayment = useMemo(
    () => new URLSearchParams(location.search).get("payment") === "success",
    [location.search],
  );
  const isPaid = charge?.status === "confirmed";
  const isExpired = charge ? new Date(charge.expiresAt).getTime() <= Date.now() : false;
  const canPay = Boolean(charge && charge.status === "requested" && !isExpired);

  useEffect(() => {
    if (chargeId) {
      setConfirmationPolls(0);
    }
  }, [chargeId]);

  useEffect(() => {
    if (!returnedFromPayment || !charge || isPaid || isExpired || confirmationPolls >= 10) {
      return;
    }

    const timeout = window.setTimeout(() => {
      setConfirmationPolls((count) => count + 1);
      loadCharge({ silent: true });
    }, 3000);

    return () => window.clearTimeout(timeout);
  }, [returnedFromPayment, charge, isPaid, isExpired, confirmationPolls, loadCharge]);

  const beginCheckout = async (provider: AppChargeProvider) => {
    if (!appId || !chargeId || !charge || !canPay) return;

    if (!ready) return;
    if (!authenticated) {
      navigate(`/login?returnTo=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      return;
    }

    setCheckoutProvider(provider);
    setError(null);
    try {
      const origin = window.location.origin;
      const currentUrl = `${origin}${location.pathname}${location.search}`;
      const successUrl = new URL("/payment/success", origin);
      successUrl.searchParams.set("charge_request_id", charge.id);
      successUrl.searchParams.set("app_id", charge.appId);

      const body =
        provider === "stripe"
          ? {
              provider,
              success_url: successUrl.toString(),
              cancel_url: currentUrl,
            }
          : {
              provider,
              return_url: successUrl.toString(),
            };

      const response = await api<CheckoutResponse>(
        `/api/v1/apps/${encodeURIComponent(appId)}/charges/${encodeURIComponent(chargeId)}/checkout`,
        {
          method: "POST",
          json: body,
        },
      );

      const checkoutUrl =
        response.checkout.provider === "stripe" ? response.checkout.url : response.checkout.payLink;

      if (!checkoutUrl) {
        throw new Error("Payment provider did not return a checkout link.");
      }

      window.location.assign(checkoutUrl);
    } catch (checkoutError) {
      setError(normalizeError(checkoutError));
      setCheckoutProvider(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#080A0D] p-4">
        <Loader2 className="h-8 w-8 animate-spin text-cyan-200/70" />
      </div>
    );
  }

  if (!details || !charge) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#080A0D] p-4 text-white">
        <div className="w-full max-w-sm border border-red-400/30 bg-red-500/10 p-5">
          <div className="flex items-center gap-3">
            <AlertCircle className="h-6 w-6 text-red-300" />
            <div>
              <h1 className="text-base font-semibold">Charge unavailable</h1>
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

  const statusIcon = isPaid ? (
    <CheckCircle2 className="h-7 w-7 text-emerald-200" />
  ) : isExpired ? (
    <AlertCircle className="h-7 w-7 text-amber-200" />
  ) : returnedFromPayment ? (
    <Loader2 className="h-7 w-7 animate-spin text-cyan-200" />
  ) : (
    <CreditCard className="h-7 w-7 text-cyan-200" />
  );
  const statusText = isPaid
    ? "Paid"
    : isExpired
      ? "Expired"
      : returnedFromPayment
        ? "Confirming"
        : "Ready";
  const statusClass = isPaid
    ? "border-emerald-300/30 bg-emerald-400/10 text-emerald-100"
    : isExpired
      ? "border-amber-300/30 bg-amber-400/10 text-amber-100"
      : "border-cyan-300/30 bg-cyan-400/10 text-cyan-100";
  const shortId = charge.id.slice(0, 8);

  return (
    <div className="min-h-screen bg-[#080A0D] px-4 py-8 text-white sm:px-6 lg:px-8">
      <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-xl items-center">
        <section className="w-full border border-white/10 bg-white/[0.03] p-5 shadow-2xl shadow-black/30 sm:p-7">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              {details.app.logo_url ? (
                <img
                  src={details.app.logo_url}
                  alt=""
                  className="h-12 w-12 shrink-0 border border-white/10 object-cover"
                />
              ) : (
                <div className="flex h-12 w-12 shrink-0 items-center justify-center border border-white/10 bg-white/5 text-sm font-semibold text-white/70">
                  {details.app.name.slice(0, 2).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold">{details.app.name}</h1>
                <p className="truncate text-sm text-white/50">
                  {charge.description || details.app.description || "App credit charge"}
                </p>
              </div>
            </div>
            <button
              type="button"
              aria-label="Refresh status"
              title="Refresh status"
              onClick={() => loadCharge()}
              disabled={isLoading}
              className="flex h-10 w-10 shrink-0 items-center justify-center border border-white/10 bg-white/5 text-white/55 transition hover:border-white/25 hover:text-white disabled:opacity-40"
            >
              <RotateCcw className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-10 flex flex-col items-center text-center">
            <div className={`flex h-16 w-16 items-center justify-center border ${statusClass}`}>
              {statusIcon}
            </div>
            <div className="mt-5 text-5xl font-semibold leading-none sm:text-6xl">
              {formatAmount(charge.amountUsd)}
            </div>
            <div className="mt-3 text-sm text-white/55">
              {statusText} - expires {formatDate(charge.expiresAt)}
            </div>
            {charge.paidAt && (
              <div className="mt-2 text-xs text-emerald-200/75">
                Confirmed {formatDate(charge.paidAt)}
              </div>
            )}
          </div>

          {error && (
            <div className="mt-7 flex items-center gap-3 border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-100">
              <AlertCircle className="h-5 w-5 shrink-0 text-red-300" />
              <span>{error}</span>
            </div>
          )}

          {returnedFromPayment && !isPaid && !isExpired && (
            <div className="mt-7 flex items-center gap-3 border border-cyan-300/25 bg-cyan-400/10 p-3 text-sm text-cyan-100">
              <Loader2 className="h-5 w-5 shrink-0 animate-spin text-cyan-200" />
              <span>Waiting for confirmation.</span>
            </div>
          )}

          <div className="mt-8 grid grid-cols-2 gap-3">
            <button
              type="button"
              aria-label="Pay with card"
              disabled={!canPay || !enabledProviders.has("stripe") || checkoutProvider !== null}
              onClick={() => beginCheckout("stripe")}
              className="group flex aspect-[1.35] min-h-28 flex-col items-center justify-center gap-3 border border-amber-300/25 bg-amber-400/10 text-amber-100 transition hover:border-amber-200/60 hover:bg-amber-300/15 disabled:pointer-events-none disabled:opacity-30"
            >
              {checkoutProvider === "stripe" ? (
                <Loader2 className="h-9 w-9 animate-spin" />
              ) : (
                <CreditCard className="h-9 w-9 transition group-hover:scale-105" />
              )}
              <span className="text-sm font-medium">Card</span>
            </button>
            <button
              type="button"
              aria-label="Pay with crypto"
              disabled={!canPay || !enabledProviders.has("oxapay") || checkoutProvider !== null}
              onClick={() => beginCheckout("oxapay")}
              className="group flex aspect-[1.35] min-h-28 flex-col items-center justify-center gap-3 border border-emerald-300/25 bg-emerald-400/10 text-emerald-100 transition hover:border-emerald-200/60 hover:bg-emerald-300/15 disabled:pointer-events-none disabled:opacity-30"
            >
              {checkoutProvider === "oxapay" ? (
                <Loader2 className="h-9 w-9 animate-spin" />
              ) : (
                <Coins className="h-9 w-9 transition group-hover:scale-105" />
              )}
              <span className="text-sm font-medium">Crypto</span>
            </button>
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-white/10 pt-4 text-xs text-white/35">
            <span>#{shortId}</span>
            <span>{charge.providers.join(" / ")}</span>
          </div>
        </section>
      </main>
    </div>
  );
}
