/**
 * /cloud/billing/success — Stripe Checkout return URL.
 *
 * The server points `success_url` here as
 * `/cloud/billing/success?session_id=...&from=settings`. On mount we POST
 * `/api/billing/checkout/verify` (the synchronous webhook fallback) so credits
 * apply immediately rather than waiting on the async webhook, then show the
 * refreshed balance.
 */

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  DashboardLoadingState,
} from "@elizaos/ui/cloud-ui";
import { ArrowRight, CheckCircle, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useSessionAuth } from "../lib/use-session-auth";
import { useCloudT } from "../shell/CloudI18nProvider";
import { CreditBalanceDisplay } from "./components/success-client";
import { useVerifyCheckout } from "./data/billing-data";
import { browserCardCheckoutIntentCoordinator } from "./lib/card-checkout-intent";

type VerificationState =
  | { generation: number; key: string; status: "pending" }
  | {
      cleanupFailed: boolean;
      generation: number;
      key: string;
      status: "verified";
    }
  | { generation: number; key: string; status: "rejected" }
  | { error: unknown; generation: number; key: string; status: "error" };

interface VerificationRequest {
  generation: number;
  key: string;
}

function isVerifiedCheckoutOutcome(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { success?: unknown }).success === true
  );
}

function PaymentIssue({
  error,
  sessionId,
}: {
  error?: unknown;
  sessionId?: string;
}) {
  const t = useCloudT();
  const message =
    error instanceof Error
      ? error.message
      : t("cloud.billingSuccess.unableToVerify", {
          defaultValue: "Unable to verify payment",
        });

  return (
    <div className="flex items-center justify-center min-h-[80vh]">
      <Card className="max-w-md w-full" role="alert" aria-live="assertive">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
            <XCircle className="h-10 w-10 text-red-500" />
          </div>
          <CardTitle className="text-2xl">
            {t("cloud.billingSuccess.paymentIssue", {
              defaultValue: "Payment Issue",
            })}
          </CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>

        <CardContent className="text-center space-y-4">
          {sessionId ? (
            <>
              <p className="text-sm text-muted-foreground">
                {t("cloud.billingSuccess.contactSupport", {
                  defaultValue:
                    "If you believe this is an error, please contact support with your session ID.",
                })}
              </p>
              <p className="text-xs text-muted-foreground bg-muted p-2 rounded-sm">
                {t("cloud.billingSuccess.sessionLabel", {
                  sessionId: `${sessionId.substring(0, 20)}...`,
                  defaultValue: "Session: {{sessionId}}",
                })}
              </p>
            </>
          ) : null}
        </CardContent>

        <CardFooter className="flex flex-col gap-2">
          <Button asChild variant="outline" className="w-full">
            <Link to="/settings#cloud-billing">
              {t("cloud.billingSuccess.backToBilling", {
                defaultValue: "Back to Billing",
              })}
            </Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

function BillingVerificationAttempt({
  checkoutSource,
  sessionId,
  verificationKey,
}: {
  checkoutSource?: "settings";
  sessionId: string;
  verificationKey: string;
}) {
  const t = useCloudT();

  const { mutate: verifyCheckout } = useVerifyCheckout();
  const [verification, setVerification] = useState<VerificationState>({
    generation: 0,
    key: verificationKey,
    status: "pending",
  });
  const activeRequest = useRef<VerificationRequest | null>(null);
  const nextGeneration = useRef(0);

  useEffect(() => {
    if (activeRequest.current?.key === verificationKey) return;

    const request = {
      generation: ++nextGeneration.current,
      key: verificationKey,
    };
    activeRequest.current = request;
    setVerification({
      generation: request.generation,
      key: verificationKey,
      status: "pending",
    });
    let cancelled = false;
    queueMicrotask(() => {
      if (
        cancelled ||
        activeRequest.current?.generation !== request.generation
      ) {
        return;
      }
      verifyCheckout(
        { from: checkoutSource, sessionId },
        {
          onError: (error) => {
            if (activeRequest.current?.generation !== request.generation)
              return;
            setVerification((current) =>
              current?.key === request.key &&
              current.generation === request.generation
                ? {
                    error,
                    generation: request.generation,
                    key: request.key,
                    status: "error",
                  }
                : current,
            );
          },
          onSuccess: (data) => {
            if (activeRequest.current?.generation !== request.generation)
              return;
            if (!isVerifiedCheckoutOutcome(data)) {
              setVerification((current) =>
                current?.key === request.key &&
                current.generation === request.generation
                  ? {
                      generation: request.generation,
                      key: request.key,
                      status: "rejected",
                    }
                  : current,
              );
              return;
            }

            // Verification is the payment authority. Show success immediately,
            // then clear only the intent bound to this exact session. Local
            // cleanup failure is non-fatal and must never rewrite a verified
            // payment as rejected.
            setVerification((current) =>
              current?.key === request.key &&
              current.generation === request.generation
                ? {
                    cleanupFailed: false,
                    generation: request.generation,
                    key: request.key,
                    status: "verified",
                  }
                : current,
            );
            void browserCardCheckoutIntentCoordinator
              .clearVerifiedSession({ sessionId })
              .catch(() => {
                // error-policy:J4 Non-authoritative cleanup failure is visibly distinguished from verified payment.
                if (activeRequest.current?.generation !== request.generation) {
                  return;
                }
                setVerification((current) =>
                  current?.status === "verified" &&
                  current.key === request.key &&
                  current.generation === request.generation
                    ? { ...current, cleanupFailed: true }
                    : current,
                );
              });
          },
        },
      );
    });

    return () => {
      cancelled = true;
      if (activeRequest.current?.generation === request.generation) {
        activeRequest.current = null;
      }
    };
  }, [checkoutSource, sessionId, verificationKey, verifyCheckout]);

  const currentVerification = verification;
  const verificationFailed =
    currentVerification?.status === "error" ||
    currentVerification?.status === "rejected";

  if (verificationFailed) {
    const error =
      currentVerification?.status === "error"
        ? currentVerification.error
        : undefined;
    return <PaymentIssue error={error} sessionId={sessionId} />;
  }

  if (currentVerification?.status !== "verified") {
    return (
      <DashboardLoadingState
        label={t("cloud.billingSuccess.verifyingPayment", {
          defaultValue: "Verifying payment",
        })}
      />
    );
  }

  return (
    <div className="flex items-center justify-center min-h-[80vh]">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
            <CheckCircle className="h-10 w-10 text-green-500" />
          </div>
          <CardTitle className="text-2xl">
            {t("cloud.billingSuccess.purchaseSuccessful", {
              defaultValue: "Purchase Successful!",
            })}
          </CardTitle>
          <CardDescription>
            {t("cloud.billingSuccess.creditsAdded", {
              defaultValue: "Your credits have been added to your account",
            })}
          </CardDescription>
        </CardHeader>

        <CardContent className="text-center space-y-4">
          <CreditBalanceDisplay />
          <p className="text-sm text-muted-foreground">
            {t("cloud.billingSuccess.creditsUsage", {
              defaultValue:
                "You can now use your credits for text generation, image creation, and video rendering.",
            })}
          </p>
          {currentVerification.cleanupFailed ? (
            <p
              role="status"
              aria-live="polite"
              className="border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300"
            >
              {t("cloud.billingSuccess.checkoutCleanupFailed", {
                defaultValue:
                  "Payment is verified, but this browser could not finish local checkout cleanup. Refresh before starting another purchase; if this continues, use another supported browser.",
              })}
            </p>
          ) : null}
        </CardContent>

        <CardFooter className="flex flex-col gap-2">
          <Button asChild variant="outline" className="w-full">
            <Link to="/settings#cloud-billing">
              {t("cloud.billingSuccess.backToBillingSettings", {
                defaultValue: "Back to Billing Settings",
              })}
            </Link>
          </Button>
          <Button asChild className="w-full">
            <Link to="/">
              {t("cloud.billingSuccess.goToDashboard", {
                defaultValue: "Go to Dashboard",
              })}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

export default function BillingSuccessPage() {
  const t = useCloudT();
  const session = useSessionAuth();
  const [params] = useSearchParams();
  const checkoutSource =
    params.get("from") === "settings" ? "settings" : undefined;
  const sessionId = params.get("session_id") ?? undefined;
  const userId = session.user?.id || null;

  if (!session.ready || !session.authenticated || !userId) {
    return (
      <DashboardLoadingState
        label={t("cloud.billingSuccess.loading", { defaultValue: "Loading" })}
      />
    );
  }

  if (!sessionId) return <PaymentIssue />;

  const verificationKey = JSON.stringify([
    userId,
    sessionId,
    checkoutSource ?? null,
  ]);

  return (
    <BillingVerificationAttempt
      key={verificationKey}
      checkoutSource={checkoutSource}
      sessionId={sessionId}
      verificationKey={verificationKey}
    />
  );
}
