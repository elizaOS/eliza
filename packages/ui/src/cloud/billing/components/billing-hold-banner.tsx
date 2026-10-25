/**
 * Billing hold banner (#22930). Shows the server-owned hold placed when a
 * refunded or disputed payment left an unpaid shortfall, with its pay action:
 * prefill a card top-up for the outstanding amount, or apply funds already in
 * the balance. The server decides whether paid usage is restored.
 */

"use client";

import { AlertCircle, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "../../../bridge/toast";
import { Alert } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";

export type BillingHoldState =
  | { status: "clear" }
  | {
      status: "held";
      outstandingUsd: string;
      payAction:
        | { kind: "add_funds"; amountUsd: string; minimumTopUpUsd: string }
        | { kind: "contact_support" };
    };

interface BillingHoldBannerProps {
  organizationId: string;
  /** Prefills the card top-up with the amount that repays the hold. */
  onPay: (amountUsd: string) => void;
  /** Called after the balance was applied so balance views refresh. */
  onBalanceApplied?: () => void;
}

export function BillingHoldBanner({
  organizationId,
  onPay,
  onBalanceApplied,
}: BillingHoldBannerProps) {
  const t = useCloudT();
  const [hold, setHold] = useState<BillingHoldState | null>(null);
  const [applying, setApplying] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api<{ data: BillingHoldState }>(
        "/api/v1/billing/hold",
      );
      setHold(response.data);
    } catch {
      // error-policy:J4 The server still enforces the hold; the banner is advisory.
      setHold(null);
    }
  }, []);

  useEffect(() => {
    void organizationId;
    void load();
  }, [organizationId, load]);

  if (hold?.status !== "held") return null;

  const outstanding = Number(hold.outstandingUsd).toFixed(2);
  const applyBalance = async () => {
    setApplying(true);
    try {
      const response = await api<{
        data: { appliedUsd: string; hold: BillingHoldState };
      }>("/api/v1/billing/hold", { method: "POST" });
      setHold(response.data.hold);
      onBalanceApplied?.();
      if (response.data.hold.status === "clear") {
        toast.success(
          t("cloud.billingHold.cleared", {
            defaultValue: "Paid usage restored.",
          }),
        );
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("cloud.billingHold.applyFailed", {
              defaultValue: "Could not apply your balance. Try again.",
            }),
      );
    } finally {
      setApplying(false);
    }
  };

  return (
    <Alert variant="dashboardError" data-testid="billing-hold-banner">
      <AlertCircle />
      <div className="flex flex-col gap-3">
        <p className="font-medium">
          {t("cloud.billingHold.title", {
            defaultValue: "Paid usage is on hold",
          })}
        </p>
        <p>
          {hold.payAction.kind === "add_funds"
            ? t("cloud.billingHold.owed", {
                amount: outstanding,
                defaultValue:
                  "A refunded or disputed payment left $" +
                  "{{amount}}" +
                  " unpaid. Inference, new agents and containers stay paused until it is repaid. Running resources keep their current funding.",
              })
            : t("cloud.billingHold.support", {
                defaultValue:
                  "A reversed payment is under review. Contact support to restore paid usage.",
              })}
        </p>
        {hold.payAction.kind === "add_funds" ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={() => {
                if (hold.payAction.kind !== "add_funds") return;
                const amount = Math.max(
                  Number(hold.payAction.amountUsd),
                  Number(hold.payAction.minimumTopUpUsd),
                );
                onPay(amount.toFixed(2));
              }}
            >
              {t("cloud.billingHold.pay", {
                amount: outstanding,
                defaultValue: "Pay $" + "{{amount}}",
              })}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={applying}
              onClick={() => {
                void applyBalance();
              }}
            >
              {applying ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("cloud.billingHold.applyBalance", {
                defaultValue: "Apply current balance",
              })}
            </Button>
          </div>
        ) : null}
      </div>
    </Alert>
  );
}
