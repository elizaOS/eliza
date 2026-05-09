import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@elizaos/cloud-ui";
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

function providerLabel(provider: AppChargeProvider): string {
  return provider === "stripe" ? "Card" : "Crypto";
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
      <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
        <Loader2 className="h-8 w-8 animate-spin text-white/60" />
      </div>
    );
  }

  if (!details || !charge) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0A0A0A] p-4">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-400" />
              Charge unavailable
            </CardTitle>
            <CardDescription>{error || "This payment link is unavailable."}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" className="w-full">
              <Link to="/">Return Home</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0A0A0A] px-4 py-8 text-white sm:px-6 lg:px-8">
      <main className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-3xl items-center">
        <Card className="w-full">
          <CardHeader className="gap-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-3">
                <div className="flex items-center gap-3">
                  {details.app.logo_url ? (
                    <img
                      src={details.app.logo_url}
                      alt=""
                      className="h-11 w-11 shrink-0 border border-white/10 object-cover"
                    />
                  ) : (
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center border border-white/10 bg-white/5 text-sm font-semibold text-white/70">
                      {details.app.name.slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <CardTitle className="truncate text-xl">{details.app.name}</CardTitle>
                    <CardDescription className="truncate">
                      {charge.description || details.app.description || "App credit charge"}
                    </CardDescription>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {isPaid ? (
                    <Badge className="border-emerald-500/30 bg-emerald-500/10 text-emerald-300">
                      Paid
                    </Badge>
                  ) : isExpired ? (
                    <Badge variant="destructive">Expired</Badge>
                  ) : (
                    <Badge>Awaiting payment</Badge>
                  )}
                  {charge.providers.map((provider) => (
                    <Badge key={provider} variant="outline">
                      {providerLabel(provider)}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="text-left sm:text-right">
                <div className="text-4xl font-semibold leading-none">
                  {formatAmount(charge.amountUsd)}
                </div>
                <div className="mt-2 text-xs text-white/50">
                  Expires {formatDate(charge.expiresAt)}
                </div>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-5">
            {error && (
              <Alert className="border-red-500/30 bg-red-500/10">
                <AlertCircle className="h-4 w-4 text-red-300" />
                <AlertDescription className="text-red-100">{error}</AlertDescription>
              </Alert>
            )}

            {isPaid && (
              <Alert className="border-emerald-500/30 bg-emerald-500/10">
                <CheckCircle2 className="h-4 w-4 text-emerald-300" />
                <AlertDescription className="text-emerald-100">
                  Payment confirmed{charge.paidAt ? ` on ${formatDate(charge.paidAt)}` : ""}.
                </AlertDescription>
              </Alert>
            )}

            {returnedFromPayment && !isPaid && !isExpired && (
              <Alert className="border-white/15 bg-white/5">
                <Loader2 className="h-4 w-4 animate-spin text-white/60" />
                <AlertDescription className="text-white/70">
                  Payment submitted. Waiting for provider confirmation.
                </AlertDescription>
              </Alert>
            )}

            {!isPaid && isExpired && (
              <Alert className="border-amber-500/30 bg-amber-500/10">
                <AlertCircle className="h-4 w-4 text-amber-300" />
                <AlertDescription className="text-amber-100">
                  This charge link has expired.
                </AlertDescription>
              </Alert>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                size="lg"
                disabled={!canPay || !enabledProviders.has("stripe") || checkoutProvider !== null}
                onClick={() => beginCheckout("stripe")}
                className="h-12"
              >
                {checkoutProvider === "stripe" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CreditCard className="h-4 w-4" />
                )}
                Pay With Card
              </Button>
              <Button
                size="lg"
                variant="outline"
                disabled={!canPay || !enabledProviders.has("oxapay") || checkoutProvider !== null}
                onClick={() => beginCheckout("oxapay")}
                className="h-12"
              >
                {checkoutProvider === "oxapay" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Coins className="h-4 w-4" />
                )}
                Pay With Crypto
              </Button>
            </div>

            <div className="flex flex-col gap-3 border-t border-white/10 pt-5 text-xs text-white/45 sm:flex-row sm:items-center sm:justify-between">
              <span>Charge ID {charge.id}</span>
              <Button variant="ghost" size="sm" onClick={() => loadCharge()} disabled={isLoading}>
                <RotateCcw className="h-3.5 w-3.5" />
                Refresh
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
