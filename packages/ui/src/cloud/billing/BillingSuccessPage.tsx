/**
 * /dashboard/billing/success — Stripe Checkout return URL.
 *
 * The server points `success_url` here as
 * `/dashboard/billing/success?session_id=...&from=settings`. On mount we POST
 * `/api/billing/checkout/verify` (the synchronous webhook fallback) so credits
 * apply immediately rather than waiting on the async webhook, then show the
 * refreshed balance. Lifted from
 * `@elizaos/cloud-frontend/src/dashboard/billing/success/Page.tsx` with Helmet
 * removed (the app shell owns the document head).
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
import { useEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useCloudT } from "../shell/CloudI18nProvider";
import { CreditBalanceDisplay } from "./components/success-client";
import { useVerifyCheckout } from "./data/billing-data";
import { useSessionAuth } from "./use-session-auth";

export default function BillingSuccessPage() {
  const t = useCloudT();
  const session = useSessionAuth();
  const [params] = useSearchParams();
  const fromSettings = params.get("from") === "settings";
  const sessionId = params.get("session_id") ?? undefined;

  const verify = useVerifyCheckout();
  const triggered = useRef(false);

  useEffect(() => {
    if (!session.ready || !session.authenticated) return;
    if (!sessionId) return;
    if (triggered.current) return;
    triggered.current = true;
    verify.mutate({
      sessionId,
      from: fromSettings ? "settings" : undefined,
    });
  }, [session.ready, session.authenticated, sessionId, fromSettings, verify]);

  if (!session.ready || !session.authenticated) {
    return (
      <DashboardLoadingState
        label={t("cloud.billingSuccess.loading", { defaultValue: "Loading" })}
      />
    );
  }

  if (sessionId && verify.isPending) {
    return (
      <DashboardLoadingState
        label={t("cloud.billingSuccess.verifyingPayment", {
          defaultValue: "Verifying payment",
        })}
      />
    );
  }

  if (verify.isError) {
    const message =
      verify.error instanceof Error
        ? verify.error.message
        : t("cloud.billingSuccess.unableToVerify", {
            defaultValue: "Unable to verify payment",
          });
    return (
      <div className="flex items-center justify-center min-h-[80vh]">
        <Card className="max-w-md w-full">
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
            <p className="text-sm text-muted-foreground">
              {t("cloud.billingSuccess.contactSupport", {
                defaultValue:
                  "If you believe this is an error, please contact support with your session ID.",
              })}
            </p>
            {sessionId && (
              <p className="text-xs text-muted-foreground bg-muted p-2 rounded-sm">
                {t("cloud.billingSuccess.sessionLabel", {
                  sessionId: `${sessionId.substring(0, 20)}...`,
                  defaultValue: "Session: {{sessionId}}",
                })}
              </p>
            )}
          </CardContent>

          <CardFooter className="flex flex-col gap-2">
            <Button asChild variant="outline" className="w-full">
              <Link
                to={fromSettings ? "/settings#billing" : "/settings#billing"}
              >
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
          <CreditBalanceDisplay sessionId={sessionId} />
          <p className="text-sm text-muted-foreground">
            {t("cloud.billingSuccess.creditsUsage", {
              defaultValue:
                "You can now use your credits for text generation, image creation, and video rendering.",
            })}
          </p>
        </CardContent>

        <CardFooter className="flex flex-col gap-2">
          <Button asChild variant="outline" className="w-full">
            <Link to="/settings#billing">
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
