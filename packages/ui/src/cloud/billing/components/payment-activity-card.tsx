/**
 * Payment activity card — server-authoritative purchase payment states
 * (receipts, refunds, disputes) for the billing history surface (#22966).
 *
 * Renders rows from GET /api/v1/billing/payment-states only; client redirect
 * or URL state never influences a row. Distinct loading / empty / error with
 * retry / success / unavailable states per the repo error policy; status is
 * never conveyed by color alone (icon + verbatim state text).
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/ui/cloud-ui";
import {
  AlertCircle,
  ArrowLeftRight,
  Ban,
  CheckCircle,
  Clock,
  LifeBuoy,
  Loader2,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import type { ComponentType } from "react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../../components/ui/button";
import { api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";

/** Mirrors the server's PaymentStateRow contract (types.ts copy rule). */
export interface PaymentStateDisplay {
  id: string;
  surface: "payment_request" | "checkout_order";
  authorityId: string;
  receiptId: string | null;
  provider: string;
  amountCents: number;
  currency: string;
  eventTime: string;
  eventTimeKind: "settlement" | "creation";
  paymentState:
    | "pending"
    | "succeeded"
    | "failed"
    | "canceled"
    | "partially_refunded"
    | "refunded"
    | "dispute_withdrawn"
    | "dispute_reinstated"
    | "unavailable";
  cumulativeRefundedUsd: number;
  cumulativeDisputedUsd: number;
  cumulativeClawbackUsd: number;
  reinstatedUsd: number;
  disputeReinstated: boolean;
  policyEffect: {
    status: "unavailable";
    reason: string;
  } | null;
  supportState: "none" | "contact_support";
  providerTxRef: string;
}

type FetchPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; rows: PaymentStateDisplay[] };

// Status is never conveyed by color alone: every branch pairs a lucide glyph
// with the verbatim state key so screen-reader and monochrome users read the
// same state as sighted color users.
function getPaymentStatePresentation(
  state: PaymentStateDisplay["paymentState"],
): {
  Icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  className: string;
} {
  switch (state) {
    case "succeeded":
      return { Icon: CheckCircle, className: "text-green-400" };
    case "pending":
      return { Icon: Clock, className: "text-txt-strong" };
    case "failed":
      return { Icon: XCircle, className: "text-red-400" };
    case "canceled":
      return { Icon: Ban, className: "text-muted-strong" };
    case "partially_refunded":
    case "refunded":
      return { Icon: RotateCcw, className: "text-amber-400" };
    case "dispute_withdrawn":
      return { Icon: ShieldAlert, className: "text-red-400" };
    case "dispute_reinstated":
      return { Icon: ShieldCheck, className: "text-amber-400" };
    default:
      return { Icon: AlertCircle, className: "text-muted-strong" };
  }
}

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function PaymentActivityCard() {
  const t = useCloudT();
  const [phase, setPhase] = useState<FetchPhase>({ kind: "loading" });

  const fetchStates = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const data = await api<{ states?: PaymentStateDisplay[] }>(
        "/api/v1/billing/payment-states",
      );
      setPhase({ kind: "ready", rows: data.states ?? [] });
    } catch (error) {
      // error-policy:J4 transport failure becomes a visible error state with
      // an explicit retry action — never a silent empty list.
      setPhase({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Payment activity could not be loaded.",
      });
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchStates();
    });
  }, [fetchStates]);

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-6">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="size-3.5 text-muted" aria-hidden={true} />
          <h3 className="text-base font-mono text-txt uppercase">
            {t("cloud.billingTab.paymentActivity", {
              defaultValue: "Payment Activity",
            })}
          </h3>
        </div>
        <p className="text-xs text-muted-strong font-mono">
          {t("cloud.billingTab.paymentActivityDescription", {
            defaultValue:
              "Server-authoritative payment receipts, refunds, and dispute states. Status is never taken from a checkout redirect.",
          })}
        </p>

        {phase.kind === "loading" ? (
          <div className="flex items-center justify-center p-8 border border-brand-surface">
            <Loader2
              className="size-6 animate-spin text-muted"
              aria-label={t("cloud.billingTab.paymentActivityLoading", {
                defaultValue: "Loading payment activity",
              })}
            />
          </div>
        ) : phase.kind === "error" ? (
          <div className="flex items-start gap-3 p-8 border border-brand-surface bg-red-500/5">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-400" />
            <div className="space-y-2">
              <p className="text-xs md:text-sm text-red-300 font-mono">
                {t("cloud.billingTab.paymentActivityLoadFailed", {
                  defaultValue: "Payment activity could not be loaded",
                })}
              </p>
              <p className="text-xs text-muted-strong font-mono">
                {phase.message}
              </p>
              <Button
                variant="ghost"
                type="button"
                onClick={() => void fetchStates()}
                className="text-xs font-mono text-txt-strong underline uppercase hover:text-txt transition-colors"
              >
                {t("cloud.billingTab.paymentActivityRetry", {
                  defaultValue: "Retry",
                })}
              </Button>
            </div>
          </div>
        ) : phase.rows.length === 0 ? (
          <div className="flex items-center justify-center p-8 border border-brand-surface">
            <p className="text-xs md:text-sm text-muted-strong font-mono">
              {t("cloud.billingTab.paymentActivityEmpty", {
                defaultValue: "No payment activity yet",
              })}
            </p>
          </div>
        ) : (
          <ul
            className="border border-brand-surface"
            data-testid="payment-activity-list"
            aria-label={t("cloud.billingTab.paymentActivity", {
              defaultValue: "Payment Activity",
            })}
          >
            {phase.rows.map((row) => {
              const { Icon: StateIcon, className: stateClassName } =
                getPaymentStatePresentation(row.paymentState);
              const reversed =
                row.paymentState === "partially_refunded" ||
                row.paymentState === "refunded" ||
                row.paymentState === "dispute_withdrawn" ||
                row.paymentState === "dispute_reinstated";
              return (
                <div
                  key={row.id}
                  data-testid="payment-state-row"
                  className="flex flex-col gap-2 p-3 md:p-4 border-b border-brand-surface last:border-b-0"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <StateIcon
                      className={`size-4 shrink-0 ${stateClassName}`}
                      aria-hidden={true}
                    />
                    <span
                      className={`text-xs md:text-sm font-mono uppercase ${stateClassName}`}
                      data-testid="payment-state-text"
                    >
                      {row.paymentState}
                    </span>
                    <span className="text-xs md:text-sm font-mono text-txt-strong uppercase tabular-nums">
                      {formatUsd(row.amountCents / 100)} {row.currency}
                    </span>
                    <span className="text-xs font-mono text-muted-strong uppercase">
                      {row.provider}
                    </span>
                    <span className="ml-auto text-xs font-mono text-muted-strong tabular-nums">
                      <time dateTime={row.eventTime}>
                        {new Date(row.eventTime).toLocaleString("en-US", {
                          year: "numeric",
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: true,
                        })}
                      </time>
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs font-mono text-muted-strong">
                    <span>
                      {t("cloud.billingTab.paymentActivityEventTime", {
                        defaultValue: "Event time",
                      })}
                      :{" "}
                      {row.eventTimeKind === "settlement"
                        ? t("cloud.billingTab.paymentTimeSettlement", {
                            defaultValue: "provider settlement",
                          })
                        : t("cloud.billingTab.paymentTimeCreation", {
                            defaultValue: "server creation",
                          })}
                    </span>
                    {row.receiptId ? (
                      <span data-testid="payment-receipt-link">
                        {t("cloud.billingTab.paymentActivityReceipt", {
                          defaultValue: "receipt",
                        })}
                      </span>
                    ) : null}
                    {row.surface === "checkout_order" ? (
                      <span>
                        {t("cloud.billingTab.paymentActivityOrder", {
                          defaultValue: "checkout order",
                        })}
                      </span>
                    ) : null}
                  </div>

                  {reversed ? (
                    <div
                      className="flex flex-col gap-1 border-l-2 border-amber-400/60 pl-3"
                      data-testid="payment-reversal-detail"
                    >
                      {row.cumulativeRefundedUsd > 0 ? (
                        <p className="text-xs font-mono text-txt-strong">
                          {t("cloud.billingTab.refundedAmount", {
                            defaultValue: "Refunded",
                          })}
                          :{" "}
                          <span data-testid="refunded-amount">
                            {formatUsd(row.cumulativeRefundedUsd)}
                          </span>
                        </p>
                      ) : null}
                      {row.cumulativeDisputedUsd > 0 ? (
                        <p className="text-xs font-mono text-txt-strong">
                          {t("cloud.billingTab.disputedAmount", {
                            defaultValue: "Disputed",
                          })}
                          :{" "}
                          <span data-testid="disputed-amount">
                            {formatUsd(row.cumulativeDisputedUsd)}
                          </span>
                        </p>
                      ) : null}
                      {row.reinstatedUsd > 0 ? (
                        <p className="text-xs font-mono text-txt-strong">
                          {t("cloud.billingTab.reinstatedAmount", {
                            defaultValue: "Reinstated",
                          })}
                          :{" "}
                          <span data-testid="reinstated-amount">
                            {formatUsd(row.reinstatedUsd)}
                          </span>
                        </p>
                      ) : null}
                      {/* Credits actually removed may differ from the provider
                          amounts after consumption; both are shown honestly. */}
                      <p className="text-xs font-mono text-muted-strong">
                        {t("cloud.billingTab.clawedBackCredits", {
                          defaultValue: "Credits removed",
                        })}
                        :{" "}
                        <span data-testid="clawback-amount">
                          {formatUsd(row.cumulativeClawbackUsd)}
                        </span>
                      </p>
                      <p
                        className="flex items-center gap-1.5 text-xs font-mono text-muted-strong"
                        data-testid="payment-policy-effect"
                      >
                        <AlertCircle
                          className="size-3.5 shrink-0"
                          aria-hidden={true}
                        />
                        {t("cloud.billingTab.policyEffectUnavailable", {
                          defaultValue:
                            "Policy effect unavailable pending refund policy decision",
                        })}
                      </p>
                      {row.supportState === "contact_support" ? (
                        <p className="flex items-center gap-1.5 text-xs font-mono text-txt-strong">
                          <LifeBuoy
                            className="size-3.5 shrink-0"
                            aria-hidden={true}
                          />
                          {t("cloud.billingTab.contactSupport", {
                            defaultValue: "Contact support for this payment",
                          })}
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </ul>
        )}
      </div>
    </BrandCard>
  );
}
