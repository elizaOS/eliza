/**
 * Payment state detail client — full server-authoritative view of one
 * payment row (#22966 linked order/receipt surface): amount/unit, provider,
 * event time and its authority kind, linked identifiers with copy support,
 * cumulative refund/dispute totals, credit-unit clawbacks, policy effect,
 * and support escalation state. Renders exactly what the provider-neutral
 * receipt authority returns; never derives state client-side.
 */

"use client";

import { CornerBrackets } from "@elizaos/ui/cloud-ui";
import { ArrowLeft, LifeBuoy } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type { PaymentStateDisplay } from "./payment-activity-card";

interface PaymentStateDetailClientProps {
  row: PaymentStateDisplay;
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

/** Formats an amount in the row's own currency; USD gets the $ sign. */
function formatAmount(amount: number, currency: string): string {
  const fractionDigits = Number.isInteger(amount) ? 0 : 2;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Unknown ISO code: Intl throws — fall back to a labeled plain number
    // instead of silently rendering dollars.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Credit-unit amounts are labeled as credits, never formatted as USD. */
function formatCredits(credits: number): string {
  return `${credits.toFixed(2)} credits`;
}

/**
 * Copies a stable identifier (receipt id, authority id) to the clipboard.
 * The full value is always visible on this surface before copying, so the
 * copy affordance is a convenience, not the only path to the identifier.
 */
async function copyReference(text: string, label: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${label} copied to clipboard`);
  } catch {
    // error-policy:J4 user-facing degrade: a failed clipboard write (older
    // browser, permission denied, insecure context) becomes a visible toast
    // telling the user the reference could not be copied — never a silent
    // no-op that looks like success.
    toast.error(`${label} could not be copied`);
  }
}

/** One label/value row in the detail grid. */
function DetailField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-mono uppercase text-muted-strong">
        {label}
      </span>
      <span
        className="text-sm font-mono text-txt-strong break-all"
        data-testid="payment-detail-field"
      >
        {children}
      </span>
    </div>
  );
}

export function PaymentStateDetailClient({
  row,
}: PaymentStateDetailClientProps) {
  const t = useCloudT();
  const navigate = useNavigate();

  const authorityLabel =
    row.surface === "checkout_order"
      ? t("cloud.billingTab.paymentActivityOrder", {
          defaultValue: "Checkout order",
        })
      : t("cloud.billingTab.paymentActivityRequest", {
          defaultValue: "Payment request",
        });

  const eventTimeKindLabel =
    row.eventTimeKind === "provider_settlement"
      ? t("cloud.billingTab.paymentTimeSettlement", {
          defaultValue: "provider settlement",
        })
      : row.eventTimeKind === "reversal_ledger_observation"
        ? t("cloud.billingTab.paymentTimeReversal", {
            defaultValue: "reversal observed",
          })
        : t("cloud.billingTab.paymentTimeCreation", {
            defaultValue: "server creation",
          });

  const formattedEventTime = new Date(row.eventTime).toLocaleString(
    "en-US",
    DATE_FORMAT,
  );

  const hasReversalDetail =
    row.cumulativeRefundedChargeCurrency > 0 ||
    row.cumulativeDisputedChargeCurrency > 0 ||
    row.cumulativeClawbackCredits > 0 ||
    row.reinstatedCredits > 0 ||
    row.unrecoveredShortfallCredits > 0 ||
    row.policyEffect !== null;

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto p-6">
      <div className="border-b border-border pb-4">
        <Button
          variant="ghostMuted"
          type="button"
          onClick={() => navigate("/settings#cloud-billing")}
          className="group flex min-h-touch items-center gap-2 font-mono text-sm"
        >
          <div className="flex items-center justify-center size-8 rounded-sm bg-bg-elevated group-hover:bg-bg-hover transition-colors">
            <ArrowLeft className="size-4" />
          </div>
          <span className="font-medium">
            {t("cloud.paymentStateDetail.backToBilling", {
              defaultValue: "Back to Billing",
            })}
          </span>
        </Button>
      </div>

      <Card variant="brand" className="relative">
        <CornerBrackets size="sm" className="opacity-50" />
        <div className="relative z-10 space-y-6">
          <div className="flex items-center gap-2">
            <h2
              className="text-base font-mono text-txt uppercase"
              data-testid="payment-detail-title"
            >
              {t("cloud.paymentStateDetail.title", {
                defaultValue: "Payment Detail",
              })}
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <DetailField
              label={t("cloud.paymentStateDetail.state", {
                defaultValue: "Payment state",
              })}
            >
              <span
                data-testid="payment-detail-state"
                className="font-mono uppercase"
              >
                {row.paymentState}
              </span>
            </DetailField>

            <DetailField
              label={t("cloud.paymentStateDetail.amount", {
                defaultValue: "Amount",
              })}
            >
              {formatAmount(row.amountCents / 100, row.currency)}
            </DetailField>

            <DetailField
              label={t("cloud.paymentStateDetail.eventTime", {
                defaultValue: "Event time",
              })}
            >
              <time dateTime={row.eventTime}>{formattedEventTime}</time>
              <span className="block text-xs text-muted-strong">
                ({eventTimeKindLabel})
              </span>
            </DetailField>

            <DetailField
              label={t("cloud.paymentStateDetail.provider", {
                defaultValue: "Provider",
              })}
            >
              <span className="uppercase">{row.provider}</span>
            </DetailField>

            <DetailField label={authorityLabel}>
              <Button
                variant="ghost"
                type="button"
                data-testid="payment-detail-authority"
                aria-label={t("cloud.billingTab.copyAuthorityReference", {
                  defaultValue: "Copy {{surface}} ID {{id}} to clipboard",
                  surface: authorityLabel,
                  id: row.authorityId,
                })}
                className="underline decoration-dotted underline-offset-2 cursor-pointer text-left"
                onClick={() => {
                  void copyReference(
                    row.authorityId,
                    authorityLabel.toLowerCase(),
                  );
                }}
              >
                {row.authorityId}
              </Button>
            </DetailField>

            <DetailField
              label={t("cloud.billingTab.paymentActivityReceipt", {
                defaultValue: "Receipt",
              })}
            >
              {row.receiptId ? (
                <Button
                  variant="ghost"
                  type="button"
                  data-testid="payment-detail-receipt"
                  aria-label={t("cloud.billingTab.copyReceiptReference", {
                    defaultValue: "Copy receipt ID {{id}} to clipboard",
                    id: row.receiptId,
                  })}
                  className="underline decoration-dotted underline-offset-2 cursor-pointer text-left"
                  onClick={() => {
                    void copyReference(
                      row.receiptId as string,
                      t("cloud.billingTab.paymentActivityReceipt", {
                        defaultValue: "receipt",
                      }),
                    );
                  }}
                >
                  {row.receiptId}
                </Button>
              ) : (
                <span
                  className="text-muted-strong"
                  data-testid="payment-detail-receipt-none"
                >
                  {t("cloud.paymentStateDetail.noReceipt", {
                    defaultValue: "No provider-neutral receipt projected",
                  })}
                </span>
              )}
            </DetailField>
          </div>

          {hasReversalDetail ? (
            <Card
              asChild
              variant="billingReversalInset"
              className="flex flex-col gap-1 pl-3"
              data-testid="payment-detail-reversal"
            >
              <div>
                {row.cumulativeRefundedChargeCurrency > 0 ? (
                  <p className="text-xs font-mono text-txt-strong">
                    {t("cloud.billingTab.refundedAmount", {
                      defaultValue: "Refunded",
                    })}
                    :{" "}
                    <span data-testid="payment-detail-refunded">
                      {formatAmount(
                        row.cumulativeRefundedChargeCurrency,
                        row.currency,
                      )}
                    </span>
                  </p>
                ) : null}
                {row.cumulativeDisputedChargeCurrency > 0 ? (
                  <p className="text-xs font-mono text-txt-strong">
                    {t("cloud.billingTab.disputedAmount", {
                      defaultValue: "Disputed",
                    })}
                    :{" "}
                    <span data-testid="payment-detail-disputed">
                      {formatAmount(
                        row.cumulativeDisputedChargeCurrency,
                        row.currency,
                      )}
                    </span>
                  </p>
                ) : null}
                {row.reinstatedCredits > 0 ? (
                  <p className="text-xs font-mono text-txt-strong">
                    {t("cloud.billingTab.reinstatedAmount", {
                      defaultValue: "Reinstated",
                    })}
                    :{" "}
                    <span data-testid="payment-detail-reinstated">
                      {formatCredits(row.reinstatedCredits)}
                    </span>
                  </p>
                ) : null}
                <p className="text-xs font-mono text-muted-strong">
                  {t("cloud.billingTab.clawedBackCredits", {
                    defaultValue: "Credits removed",
                  })}
                  :{" "}
                  <span data-testid="payment-detail-clawback">
                    {formatCredits(row.cumulativeClawbackCredits)}
                  </span>
                </p>
                {row.unrecoveredShortfallCredits > 0 ? (
                  <p className="text-xs font-mono text-warn">
                    {t("cloud.billingTab.unrecoveredShortfall", {
                      defaultValue: "Unrecovered balance shortfall",
                    })}
                    :{" "}
                    <span data-testid="payment-detail-shortfall">
                      {formatCredits(row.unrecoveredShortfallCredits)}
                    </span>
                  </p>
                ) : null}
                {row.policyEffect !== null ? (
                  <p
                    className="flex items-center gap-1.5 text-xs font-mono text-muted-strong"
                    data-testid="payment-detail-policy-effect"
                  >
                    {t("cloud.billingTab.policyEffectUnavailable", {
                      defaultValue:
                        "Policy effect unavailable pending refund policy decision",
                    })}
                  </p>
                ) : null}
              </div>
            </Card>
          ) : null}

          {row.supportState === "contact_support" ? (
            <p className="flex items-center gap-1.5 text-xs font-mono text-txt-strong">
              <LifeBuoy className="size-3.5 shrink-0" aria-hidden={true} />
              {t("cloud.billingTab.contactSupport", {
                defaultValue: "Contact support for this payment",
              })}
            </p>
          ) : null}
        </div>
      </Card>
    </div>
  );
}
