/**
 * Payment activity card — server-authoritative purchase payment states
 * (receipts, refunds, disputes) for the billing history surface (#22966).
 *
 * Renders rows from GET /api/v1/billing/payment-states only; client redirect
 * or URL state never influences a row. Distinct loading / empty / error with
 * retry / success / unavailable states per the repo error policy; status is
 * never conveyed by color alone (icon + verbatim state text). Credit amounts
 * are labeled as credits — never formatted as currency.
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
import { toast } from "sonner";
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
  eventTimeKind:
    | "provider_settlement"
    | "server_creation"
    | "reversal_ledger_observation";
  paymentState:
    | "pending"
    | "succeeded"
    | "failed"
    | "canceled"
    | "expired"
    | "partially_refunded"
    | "refunded"
    | "dispute_withdrawn"
    | "dispute_reinstated"
    | "unavailable";
  cumulativeRefundedUsd: number;
  cumulativeDisputedUsd: number;
  cumulativeClawbackCredits: number;
  reinstatedCredits: number;
  unrecoveredShortfallUsd: number;
  disputeReinstated: boolean;
  policyEffect: {
    status: "unavailable";
    reason: string;
  } | null;
  supportState: "none" | "contact_support";
}

interface PaymentStatesResponse {
  states: PaymentStateDisplay[];
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
    case "expired":
      return { Icon: Clock, className: "text-muted-strong" };
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

const CURRENCY_LOCALE = "en-US";

/** Formats an amount in the row's own currency; USD gets the $ sign. */
function formatAmount(amount: number, currency: string): string {
  const fractionDigits = Number.isInteger(amount) ? 0 : 2;
  try {
    return new Intl.NumberFormat(CURRENCY_LOCALE, {
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
 * Copies a provider-neutral receipt or authority id to the clipboard. No
 * receipt/order detail route exists in the cloud console (only
 * `cloud/invoices/:id` for Stripe subscription invoices — a different
 * object), so the actionable link for support/escalation is a copyable
 * stable identifier, never a dead span.
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

export function PaymentActivityCard() {
  const t = useCloudT();
  const [phase, setPhase] = useState<FetchPhase>({ kind: "loading" });

  const fetchStates = useCallback(async () => {
    setPhase({ kind: "loading" });
    try {
      const data = await api<PaymentStatesResponse>(
        "/api/v1/billing/payment-states",
      );
      // A malformed success response is an error state, never a healthy
      // empty history: `states` is required by the route contract.
      if (
        !data ||
        !Array.isArray(data.states) ||
        !data.states.every(
          (row) =>
            row &&
            typeof row.id === "string" &&
            typeof row.paymentState === "string",
        )
      ) {
        // error-policy:J4 malformed transport payload becomes a visible error.
        setPhase({
          kind: "error",
          message: "Payment activity response was malformed.",
        });
        return;
      }
      setPhase({ kind: "ready", rows: data.states });
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
              // Reversal detail visibility comes from the authoritative
              // reversal data, not the visible state enum: an unavailable row
              // (e.g. settled-without-receipt) can still carry refund/dispute
              // totals, a policy effect, and a support escalation state that
              // must not be hidden because the state projection is unknown.
              const reversed =
                row.policyEffect?.status === "unavailable" ||
                row.cumulativeRefundedUsd > 0 ||
                row.cumulativeDisputedUsd > 0 ||
                row.cumulativeClawbackCredits > 0 ||
                row.reinstatedCredits > 0;
              return (
                <li
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
                      {formatAmount(row.amountCents / 100, row.currency)}
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
                    <span data-testid="payment-event-time-kind">
                      {t("cloud.billingTab.paymentActivityEventTime", {
                        defaultValue: "Event time",
                      })}
                      :{" "}
                      {row.eventTimeKind === "provider_settlement"
                        ? t("cloud.billingTab.paymentTimeSettlement", {
                            defaultValue: "provider settlement",
                          })
                        : row.eventTimeKind === "reversal_ledger_observation"
                          ? t("cloud.billingTab.paymentTimeReversal", {
                              defaultValue: "reversal observed",
                            })
                          : t("cloud.billingTab.paymentTimeCreation", {
                              defaultValue: "server creation",
                            })}
                    </span>
                    {row.receiptId ? (
                      <button
                        type="button"
                        data-testid="payment-receipt-link"
                        aria-label={t("cloud.billingTab.copyReceiptReference", {
                          defaultValue: "Copy receipt ID {{id}} to clipboard",
                          id: row.receiptId,
                        })}
                        title={row.receiptId}
                        className="underline decoration-dotted underline-offset-2 hover:text-txt-strong cursor-pointer"
                        onClick={() => {
                          void copyReference(
                            row.receiptId as string,
                            t("cloud.billingTab.paymentActivityReceipt", {
                              defaultValue: "receipt",
                            }),
                          );
                        }}
                      >
                        {t("cloud.billingTab.paymentActivityReceipt", {
                          defaultValue: "receipt",
                        })}
                        :{" "}
                        <span className="text-txt-strong">
                          {row.receiptId.slice(0, 8)}
                        </span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      data-testid="payment-authority-link"
                      aria-label={t("cloud.billingTab.copyAuthorityReference", {
                        defaultValue: "Copy {{surface}} ID {{id}} to clipboard",
                        surface:
                          row.surface === "checkout_order"
                            ? t("cloud.billingTab.paymentActivityOrder", {
                                defaultValue: "checkout order",
                              })
                            : t("cloud.billingTab.paymentActivityRequest", {
                                defaultValue: "payment request",
                              }),
                        id: row.authorityId,
                      })}
                      title={row.authorityId}
                      className="underline decoration-dotted underline-offset-2 hover:text-txt-strong cursor-pointer"
                      onClick={() => {
                        void copyReference(
                          row.authorityId,
                          row.surface === "checkout_order"
                            ? t("cloud.billingTab.paymentActivityOrder", {
                                defaultValue: "checkout order",
                              })
                            : t("cloud.billingTab.paymentActivityRequest", {
                                defaultValue: "payment request",
                              }),
                        );
                      }}
                    >
                      {row.surface === "checkout_order"
                        ? t("cloud.billingTab.paymentActivityOrder", {
                            defaultValue: "checkout order",
                          })
                        : t("cloud.billingTab.paymentActivityRequest", {
                            defaultValue: "payment request",
                          })}
                      :{" "}
                      <span className="text-txt-strong">
                        {row.authorityId.slice(0, 8)}
                      </span>
                    </button>
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
                            {formatAmount(row.cumulativeRefundedUsd, "USD")}
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
                            {formatAmount(row.cumulativeDisputedUsd, "USD")}
                          </span>
                        </p>
                      ) : null}
                      {row.reinstatedCredits > 0 ? (
                        <p className="text-xs font-mono text-txt-strong">
                          {t("cloud.billingTab.reinstatedAmount", {
                            defaultValue: "Reinstated",
                          })}
                          :{" "}
                          <span data-testid="reinstated-amount">
                            {formatCredits(row.reinstatedCredits)}
                          </span>
                        </p>
                      ) : null}
                      {/* Credits actually removed may differ from the provider
                          amounts after consumption; labeled as credits, not
                          dollars. */}
                      <p className="text-xs font-mono text-muted-strong">
                        {t("cloud.billingTab.clawedBackCredits", {
                          defaultValue: "Credits removed",
                        })}
                        :{" "}
                        <span data-testid="clawback-amount">
                          {formatCredits(row.cumulativeClawbackCredits)}
                        </span>
                      </p>
                      {row.unrecoveredShortfallUsd > 0 ? (
                        <p className="text-xs font-mono text-amber-300">
                          {t("cloud.billingTab.unrecoveredShortfall", {
                            defaultValue: "Unrecovered balance shortfall",
                          })}
                          :{" "}
                          <span data-testid="shortfall-amount">
                            {formatAmount(row.unrecoveredShortfallUsd, "USD")}
                          </span>
                        </p>
                      ) : null}
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
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </BrandCard>
  );
}
