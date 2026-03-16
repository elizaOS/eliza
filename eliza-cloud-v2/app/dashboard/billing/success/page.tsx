import type { Metadata } from "next";
import { logger } from "@/lib/utils/logger";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CheckCircle, XCircle, ArrowRight } from "lucide-react";
import { CreditBalanceDisplay } from "@/components/billing/success-client";
import { requireStripe } from "@/lib/stripe";
import { creditsService } from "@/lib/services/credits";
import { invoicesService } from "@/lib/services/invoices";

export const metadata: Metadata = {
  title: "Purchase Successful",
  description: "Your credit purchase was successful",
};

interface BillingSuccessPageProps {
  searchParams: Promise<{ from?: string; session_id?: string }>;
}

/**
 * Verifies and processes a Stripe checkout session.
 * Acts as a fallback if the webhook doesn't fire (e.g., local development).
 * The creditsService.addCredits has built-in idempotency to prevent duplicates.
 *
 * @param sessionId - The Stripe checkout session ID.
 * @returns An object indicating success, error, credits added, and whether it was already processed.
 */
async function verifyAndProcessSession(sessionId: string): Promise<{
  success: boolean;
  error?: string;
  credits?: number;
  alreadyProcessed?: boolean;
}> {
  // Fetch the session from Stripe
  const session = await requireStripe().checkout.sessions.retrieve(sessionId);

  if (session.payment_status !== "paid") {
    console.warn(
      `[BillingSuccess] Session ${sessionId} not paid: ${session.payment_status}`,
    );
    return {
      success: false,
      error: `Payment not completed. Status: ${session.payment_status}`,
    };
  }

  const organizationId = session.metadata?.organization_id;
  const userId = session.metadata?.user_id;
  const creditsStr = session.metadata?.credits || "0";
  const credits = parseAndValidateCredits(creditsStr);
  const purchaseType = session.metadata?.type || "checkout";
  const paymentIntentId = session.payment_intent as string;

  if (!organizationId || !credits) {
    console.warn("[BillingSuccess] Invalid metadata", {
      hasOrgId: !!organizationId,
      hasValidCredits: !!credits,
    });
    return {
      success: false,
      error: "Invalid session metadata",
    };
  }

  if (!paymentIntentId) {
    console.warn("[BillingSuccess] No payment intent ID in session");
    return {
      success: false,
      error: "No payment intent found",
    };
  }

  // Check if already processed (idempotency check)
  const existingTransaction =
    await creditsService.getTransactionByStripePaymentIntent(paymentIntentId);

  if (existingTransaction) {
    return {
      success: true,
      credits,
      alreadyProcessed: true,
    };
  }

  await creditsService.addCredits({
    organizationId,
    amount: credits,
    description: `Balance top-up - $${credits.toFixed(2)}`,
    metadata: {
      user_id: userId,
      payment_intent_id: paymentIntentId,
      session_id: sessionId,
      type: purchaseType,
      source: "success_page_fallback",
    },
    stripePaymentIntentId: paymentIntentId,
  });

  // Create invoice record
  try {
    const existingInvoice = await invoicesService.getByStripeInvoiceId(
      `cs_${sessionId}`,
    );

    if (!existingInvoice) {
      const amountTotal = session.amount_total
        ? (session.amount_total / 100).toString()
        : credits.toString();

      await invoicesService.create({
        organization_id: organizationId,
        stripe_invoice_id: `cs_${sessionId}`,
        stripe_customer_id: session.customer as string,
        stripe_payment_intent_id: paymentIntentId,
        amount_due: amountTotal,
        amount_paid: amountTotal,
        currency: session.currency || "usd",
        status: "paid",
        invoice_type: purchaseType,
        invoice_number: undefined,
        invoice_pdf: undefined,
        hosted_invoice_url: undefined,
        credits_added: credits.toString(),
        metadata: {
          type: purchaseType,
          session_id: sessionId,
          source: "success_page_fallback",
        },
        paid_at: new Date(),
      });
    }
  } catch (invoiceError) {
    // Non-critical - credits were added successfully
    logger.error(
      "[BillingSuccess] Invoice creation error (non-critical):",
      invoiceError,
    );
  }

  await creditsService.addCredits({
    organizationId,
    amount: credits,
    description: `Balance top-up - $${credits.toFixed(2)}`,
    metadata: {
      user_id: userId,
      payment_intent_id: paymentIntentId,
      session_id: sessionId,
      type: purchaseType,
      source: "success_page_fallback",
    },
    stripePaymentIntentId: paymentIntentId,
  });

  // Create invoice record
  const existingInvoice = await invoicesService.getByStripeInvoiceId(
    `cs_${sessionId}`,
  );

  if (!existingInvoice) {
    const amountTotal = session.amount_total
      ? (session.amount_total / 100).toString()
      : credits.toString();

    await invoicesService.create({
      organization_id: organizationId,
      stripe_invoice_id: `cs_${sessionId}`,
      stripe_customer_id: session.customer as string,
      stripe_payment_intent_id: paymentIntentId,
      amount_due: amountTotal,
      amount_paid: amountTotal,
      currency: session.currency || "usd",
      status: "paid",
      invoice_type: purchaseType,
      invoice_number: undefined,
      invoice_pdf: undefined,
      hosted_invoice_url: undefined,
      credits_added: credits.toString(),
      metadata: {
        type: purchaseType,
        session_id: sessionId,
        source: "success_page_fallback",
      },
      paid_at: new Date(),
    });
  }

  return {
    success: true,
    credits,
    alreadyProcessed: false,
  };
}

/**
 * Billing success page displayed after a successful Stripe checkout session.
 * Verifies the payment and processes credit addition if not already handled by webhook.
 * Shows success or error state based on payment verification.
 *
 * @param searchParams - Search parameters, including `from` (redirect source) and `session_id` (Stripe session ID).
 * @returns The rendered billing success page with payment status and credit balance.
 */
export default async function BillingSuccessPage({
  searchParams,
}: BillingSuccessPageProps) {
  const params = await searchParams;
  const fromSettings = params.from === "settings";
  const sessionId = params.session_id;

  // Verify and process the session if session_id is provided
  let verificationResult:
    | {
        success: boolean;
        error?: string;
        credits?: number;
        alreadyProcessed?: boolean;
      }
    | undefined = undefined;

  if (sessionId) {
    const result = await verifyAndProcessSession(sessionId);
    verificationResult = result;
  }

  // Show error state if verification failed
  if (verificationResult && !verificationResult.success) {
    return (
      <div className="flex items-center justify-center min-h-[80vh]">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-red-500/10">
              <XCircle className="h-10 w-10 text-red-500" />
            </div>
            <CardTitle className="text-2xl">Payment Issue</CardTitle>
            <CardDescription>
              {verificationResult.error || "Unable to verify payment"}
            </CardDescription>
          </CardHeader>

          <CardContent className="text-center space-y-4">
            <p className="text-sm text-muted-foreground">
              If you believe this is an error, please contact support with your
              session ID.
            </p>
            {sessionId && (
              <p className="text-xs text-muted-foreground bg-muted p-2 rounded">
                Session: {sessionId.substring(0, 20)}...
              </p>
            )}
          </CardContent>

          <CardFooter className="flex flex-col gap-2">
            <Button asChild variant="outline" className="w-full">
              <Link
                href={
                  fromSettings
                    ? "/dashboard/settings?tab=billing"
                    : "/dashboard/billing"
                }
              >
                Back to Billing
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
          <CardTitle className="text-2xl">Purchase Successful!</CardTitle>
          <CardDescription>
            {verificationResult?.credits
              ? `$${verificationResult.credits.toFixed(2)} has been added to your account`
              : "Your credits have been added to your account"}
          </CardDescription>
        </CardHeader>

        <CardContent className="text-center space-y-4">
          <CreditBalanceDisplay
            sessionId={sessionId}
            creditsAdded={verificationResult?.credits}
          />

          <p className="text-sm text-muted-foreground">
            You can now use your credits for text generation, image creation,
            and video rendering.
          </p>
        </CardContent>

        <CardFooter className="flex flex-col gap-2">
          {fromSettings ? (
            <>
              <Button asChild variant="outline" className="w-full">
                <Link href="/dashboard/settings?tab=billing">
                  Back to Billing Settings
                </Link>
              </Button>
              <Button asChild className="w-full">
                <Link href="/dashboard">
                  Go to Dashboard
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </>
          ) : (
            <>
              <Button asChild variant="outline" className="w-full">
                <Link href="/dashboard/billing">View Billing</Link>
              </Button>
              <Button asChild className="w-full">
                <Link href="/dashboard">
                  Go to Dashboard
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
            </>
          )}
        </CardFooter>
      </Card>
    </div>
  );
}
