/**
 * Payment activity card — server-authoritative purchase payment states
 * (receipts, refunds, disputes) for the billing history surface (#22966).
 *
 * Renders rows from GET /api/v1/billing/payment-states only; client redirect
 * or URL state never influences a row. Distinct loading / empty / error with
 * retry / success / unavailable states per the repo error policy; status is
 * never conveyed by color alone (icon + verbatim state text). Credit amounts
 * are labeled as credits — never formatted as currency. Each row links to
 * its payment-state detail at `cloud/billing/payments/:id` (#22966 linked
 * order/receipt surface) with copyable identifiers there.
 */

"use client";

import { CornerBrackets } from "@elizaos/ui/cloud-ui";
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
import { Link } from "react-router-dom";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { isPaymentStateRow } from "./payment-state-row-validation";

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
  cumulativeRefundedChargeCurrency: number;
  cumulativeDisputedChargeCurrency: number;
  cumulativeClawbackCredits: number;
  reinstatedCredits: number;
  unrecoveredShortfallCredits: number;
  disputeReinstated: boolean;
  policyEffect: {
    status: "unavailable";
    reason: string;
  } | null;
  supportState: "none" | "contact_support";
}

interface PaymentStatesResponse {
  states: PaymentStateDisplay[];
  /** Route contract fields; treated as optional so a payload missing them
   *  still renders the page (no pagination controls) instead of erroring. */
  total?: number;
  offset?: number;
  hasMore?: boolean;
}

type FetchPhase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      rows: PaymentStateDisplay[];
      hasMore: boolean;
      total: number | null;
      envelope: boolean;
    };

/** Matches the list route's default first-page limit (`limit=50, offset=0`). */
const PAGE_SIZE = 50;

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
      return { Icon: CheckCircle, className: "text-status-success" };
    case "pending":
      return { Icon: Clock, className: "text-txt-strong" };
    case "failed":
      return { Icon: XCircle, className: "text-destructive" };
    case "canceled":
      return { Icon: Ban, className: "text-muted-strong" };
    case "expired":
      return { Icon: Clock, className: "text-muted-strong" };
    case "partially_refunded":
    case "refunded":
      return { Icon: RotateCcw, className: "text-warn" };
    case "dispute_withdrawn":
      return { Icon: ShieldAlert, className: "text-destructive" };
    case "dispute_reinstated":
      return { Icon: ShieldCheck, className: "text-warn" };
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

export function PaymentActivityCard() {
  const t = useCloudT();
  const [phase, setPhase] = useState<FetchPhase>({ kind: "loading" });

  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);

  const fetchStates = useCallback(async () => {
    setPhase({ kind: "loading" });
    setLoadMoreError(null);
    try {
      const data = await api<PaymentStatesResponse>(
        "/api/v1/billing/payment-states",
      );
      // A malformed success response is an error state, never a healthy
      // empty history: `states` is required by the route contract, and every
      // row must pass full-shape validation — rendering dereferences
      // identifiers, amounts, event fields, and reversal totals, so a
      // partial row would tear the surface down mid-render (#26752 review).
      if (
        !data ||
        !Array.isArray(data.states) ||
        !data.states.every(isPaymentStateRow)
      ) {
        // error-policy:J4 malformed transport payload becomes a visible error.
        setPhase({
          kind: "error",
          message: "Payment activity response was malformed.",
        });
        return;
      }
      // Pagination envelope: `total`/`offset`/`hasMore` come from the list
      // route contract. Defensive when absent (older payloads / proxies): a
      // missing envelope degrades to "no pagination controls", and hasMore is
      // also derived from the page length so a short page ends traversal.
      const total =
        typeof data.total === "number" && Number.isFinite(data.total)
          ? data.total
          : null;
      const hasMore =
        typeof data.hasMore === "boolean"
          ? data.hasMore
          : total !== null && data.states.length >= PAGE_SIZE;
      const envelope = typeof data.hasMore === "boolean" || total !== null;
      setPhase({
        kind: "ready",
        rows: data.states,
        hasMore,
        total,
        envelope,
      });
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

  /** Fetches the next page (offset = rows already shown) and appends it.
   *  Failures leave the existing rows intact with an inline retry — a paging
   *  failure must never tear down already-loaded history. */
  const loadMore = useCallback(async () => {
    if (phase.kind !== "ready" || loadingMore || !phase.hasMore) return;
    setLoadingMore(true);
    setLoadMoreError(null);
    try {
      const data = await api<PaymentStatesResponse>(
        `/api/v1/billing/payment-states?offset=${phase.rows.length}`,
      );
      if (
        !data ||
        !Array.isArray(data.states) ||
        !data.states.every(isPaymentStateRow)
      ) {
        setLoadMoreError("Payment activity response was malformed.");
        return;
      }
      const total =
        typeof data.total === "number" && Number.isFinite(data.total)
          ? data.total
          : phase.total;
      const hasMore =
        typeof data.hasMore === "boolean"
          ? data.hasMore
          : total !== null && data.states.length >= PAGE_SIZE;
      setPhase({
        kind: "ready",
        rows: [...phase.rows, ...data.states],
        hasMore,
        total,
        envelope: true,
      });
    } catch (error) {
      setLoadMoreError(
        error instanceof Error
          ? error.message
          : "Older payments could not be loaded.",
      );
    } finally {
      setLoadingMore(false);
    }
  }, [phase, loadingMore]);

  return (
    <Card variant="brand" className="relative">
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
          <Card
            variant="brandSurface"
            surface="transparent"
            className="flex items-center justify-center p-8"
          >
            <Loader2
              className="size-6 animate-spin text-muted"
              aria-label={t("cloud.billingTab.paymentActivityLoading", {
                defaultValue: "Loading payment activity",
              })}
            />
          </Card>
        ) : phase.kind === "error" ? (
          <Card
            variant="brandSurface"
            surface="destructiveSubtle"
            className="flex items-start gap-3 p-8"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="space-y-2">
              <p className="text-xs md:text-sm text-destructive font-mono">
                {t("cloud.billingTab.paymentActivityLoadFailed", {
                  defaultValue: "Payment activity could not be loaded",
                })}
              </p>
              <p className="text-xs text-muted-strong font-mono">
                {phase.message}
              </p>
              <Button
                variant="linkMono"
                type="button"
                onClick={() => void fetchStates()}
              >
                {t("cloud.billingTab.paymentActivityRetry", {
                  defaultValue: "Retry",
                })}
              </Button>
            </div>
          </Card>
        ) : phase.rows.length === 0 ? (
          <Card
            variant="brandSurface"
            surface="transparent"
            className="flex items-center justify-center p-8"
          >
            <p className="text-xs md:text-sm text-muted-strong font-mono">
              {t("cloud.billingTab.paymentActivityEmpty", {
                defaultValue: "No payment activity yet",
              })}
            </p>
          </Card>
        ) : (
          <Card
            asChild
            variant="brandSurface"
            surface="transparent"
            className="list-none divide-y divide-brand-surface"
            data-testid="payment-activity-list"
            aria-label={t("cloud.billingTab.paymentActivity", {
              defaultValue: "Payment Activity",
            })}
          >
            <ul>
              {phase.rows.map((row) => {
                const { Icon: StateIcon, className: stateClassName } =
                  getPaymentStatePresentation(row.paymentState);
                // Reversal detail visibility comes from the authoritative
                // reversal data, not the visible state enum: an unavailable row
                // (e.g. settled-without-receipt) can still carry refund/dispute
                // totals, a policy effect, and a support escalation state that
                // must not be hidden because the state projection is unknown.
                // Same field set the detail surface gates its reversal
                // block on: a row carrying ONLY a shortfall or a support
                // escalation must show its reversal detail here too, or the
                // two surfaces disagree on what the authority returned.
                const reversed =
                  row.policyEffect?.status === "unavailable" ||
                  row.cumulativeRefundedChargeCurrency > 0 ||
                  row.cumulativeDisputedChargeCurrency > 0 ||
                  row.cumulativeClawbackCredits > 0 ||
                  row.reinstatedCredits > 0 ||
                  row.unrecoveredShortfallCredits > 0 ||
                  row.supportState === "contact_support";
                return (
                  <li
                    key={row.id}
                    data-testid="payment-state-row"
                    className="flex flex-col gap-2 p-3 md:p-4"
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
                        <Link
                          to={`/cloud/billing/payments/${encodeURIComponent(row.id)}`}
                          data-testid="payment-receipt-link"
                          aria-label={t("cloud.billingTab.viewReceiptDetail", {
                            defaultValue: "View receipt {{id}} payment detail",
                            id: row.receiptId,
                          })}
                          title={row.receiptId}
                          className="underline decoration-dotted underline-offset-2 hover:text-txt-strong cursor-pointer"
                        >
                          {t("cloud.billingTab.paymentActivityReceipt", {
                            defaultValue: "receipt",
                          })}
                          :{" "}
                          <span className="text-txt-strong">
                            {row.receiptId.slice(0, 8)}
                          </span>
                        </Link>
                      ) : null}
                      <Link
                        to={`/cloud/billing/payments/${encodeURIComponent(row.id)}`}
                        data-testid="payment-authority-link"
                        aria-label={t("cloud.billingTab.viewAuthorityDetail", {
                          defaultValue:
                            "View {{surface}} {{id}} payment detail",
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
                      </Link>
                    </div>

                    {reversed ? (
                      <Card
                        asChild
                        variant="billingReversalInset"
                        className="flex flex-col gap-1 pl-3"
                        data-testid="payment-reversal-detail"
                      >
                        <div>
                          {row.cumulativeRefundedChargeCurrency > 0 ? (
                            <p className="text-xs font-mono text-txt-strong">
                              {t("cloud.billingTab.refundedAmount", {
                                defaultValue: "Refunded",
                              })}
                              :{" "}
                              <span data-testid="refunded-amount">
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
                              <span data-testid="disputed-amount">
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
                          {row.unrecoveredShortfallCredits > 0 ? (
                            <p className="text-xs font-mono text-warn">
                              {t("cloud.billingTab.unrecoveredShortfall", {
                                defaultValue: "Unrecovered balance shortfall",
                              })}
                              :{" "}
                              <span data-testid="shortfall-amount">
                                {formatCredits(row.unrecoveredShortfallCredits)}
                              </span>
                            </p>
                          ) : null}
                          {row.policyEffect !== null ? (
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
                          ) : null}
                          {row.supportState === "contact_support" ? (
                            <p className="flex items-center gap-1.5 text-xs font-mono text-txt-strong">
                              <LifeBuoy
                                className="size-3.5 shrink-0"
                                aria-hidden={true}
                              />
                              {t("cloud.billingTab.contactSupport", {
                                defaultValue:
                                  "Contact support for this payment",
                              })}
                            </p>
                          ) : null}
                        </div>
                      </Card>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </Card>
        )}

        {phase.kind === "ready" && phase.rows.length > 0 ? (
          <div
            className="flex flex-col gap-2"
            data-testid="payment-activity-pagination"
          >
            {loadMoreError !== null ? (
              <p
                className="flex items-center gap-1.5 text-xs font-mono text-destructive"
                data-testid="payment-activity-load-more-error"
              >
                <AlertCircle className="size-3.5 shrink-0" aria-hidden={true} />
                {t("cloud.billingTab.paymentActivityLoadMoreFailed", {
                  defaultValue: "Older payments could not be loaded",
                })}
                : {loadMoreError}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-between gap-2">
              {phase.total !== null ? (
                <p
                  className="text-xs font-mono text-muted-strong tabular-nums"
                  data-testid="payment-activity-count"
                >
                  {t("cloud.billingTab.paymentActivityCount", {
                    defaultValue: "Showing {{shown}} of {{total}} payments",
                    shown: phase.rows.length,
                    total: phase.total,
                  })}
                </p>
              ) : null}
              {phase.hasMore ? (
                <Button
                  variant="linkMono"
                  type="button"
                  disabled={loadingMore}
                  onClick={() => void loadMore()}
                  data-testid="payment-activity-load-more"
                >
                  {loadingMore
                    ? t("cloud.billingTab.paymentActivityLoadingMore", {
                        defaultValue: "Loading older payments…",
                      })
                    : t("cloud.billingTab.paymentActivityLoadMore", {
                        defaultValue: "Load older payments",
                      })}
                </Button>
              ) : phase.envelope ? (
                <p
                  className="text-xs font-mono text-muted-strong"
                  data-testid="payment-activity-end"
                >
                  {t("cloud.billingTab.paymentActivityAllShown", {
                    defaultValue: "All payments shown",
                  })}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
