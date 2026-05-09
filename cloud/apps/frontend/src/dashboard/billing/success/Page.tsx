import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  DashboardLoadingState,
} from "@elizaos/cloud-ui";
import { ArrowRight, CheckCircle, XCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { Helmet } from "react-helmet-async";
import { Link, useSearchParams } from "react-router-dom";
import { CreditBalanceDisplay } from "../_components/success-client";
import { useRequireAuth } from "../../../lib/auth-hooks";
import { useVerifyCheckout } from "../../../lib/data/credits";

export default function BillingSuccessPage() {
  const session = useRequireAuth();
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

  const helmet = (
    <Helmet>
      <title>Purchase Successful</title>
      <meta name="description" content="Your credit purchase was successful" />
    </Helmet>
  );

  if (!session.ready || !session.authenticated) {
    return (
      <>
        {helmet}
        <DashboardLoadingState label="Loading" />
      </>
    );
  }

  if (sessionId && verify.isPending) {
    return (
      <>
        {helmet}
        <DashboardLoadingState label="Verifying payment" />
      </>
    );
  }

  if (verify.isError) {
    const message =
      verify.error instanceof Error ? verify.error.message : "Unable to verify payment";
    return (
      <>
        {helmet}
        <div className="flex items-center justify-center min-h-[80vh]">
          <Card className="max-w-md w-full">
            <CardHeader className="text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
                <XCircle className="h-10 w-10 text-red-500" />
              </div>
              <CardTitle className="text-2xl">Payment Issue</CardTitle>
              <CardDescription>{message}</CardDescription>
            </CardHeader>

            <CardContent className="text-center space-y-4">
              <p className="text-sm text-muted-foreground">
                If you believe this is an error, please contact support with your session ID.
              </p>
              {sessionId && (
                <p className="text-xs text-muted-foreground bg-muted p-2 rounded">
                  Session: {sessionId.substring(0, 20)}...
                </p>
              )}
            </CardContent>

            <CardFooter className="flex flex-col gap-2">
              <Button asChild variant="outline" className="w-full">
                <Link to={fromSettings ? "/dashboard/settings?tab=billing" : "/dashboard/billing"}>
                  Back to Billing
                </Link>
              </Button>
            </CardFooter>
          </Card>
        </div>
      </>
    );
  }

  return (
    <>
      {helmet}
      <div className="flex items-center justify-center min-h-[80vh]">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-green-500/10">
              <CheckCircle className="h-10 w-10 text-green-500" />
            </div>
            <CardTitle className="text-2xl">Purchase Successful!</CardTitle>
            <CardDescription>Your credits have been added to your account</CardDescription>
          </CardHeader>

          <CardContent className="text-center space-y-4">
            <CreditBalanceDisplay sessionId={sessionId} />
            <p className="text-sm text-muted-foreground">
              You can now use your credits for text generation, image creation, and video rendering.
            </p>
          </CardContent>

          <CardFooter className="flex flex-col gap-2">
            {fromSettings ? (
              <>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/dashboard/settings?tab=billing">Back to Billing Settings</Link>
                </Button>
                <Button asChild className="w-full">
                  <Link to="/dashboard">
                    Go to Dashboard
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </>
            ) : (
              <>
                <Button asChild variant="outline" className="w-full">
                  <Link to="/dashboard/billing">View Billing</Link>
                </Button>
                <Button asChild className="w-full">
                  <Link to="/dashboard">
                    Go to Dashboard
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Link>
                </Button>
              </>
            )}
          </CardFooter>
        </Card>
      </div>
    </>
  );
}
