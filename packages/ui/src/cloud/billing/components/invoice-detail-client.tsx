/**
 * Invoice detail view: labelled invoice status and payment fields as
 * SettingsStack / SettingsGroup / SettingsRow. Download PDF and View in Stripe
 * stay header actions (real links). The transaction line-item table stays a
 * BrandCard — it is a table, not a labelled status readout.
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/ui/cloud-ui";
import { ArrowLeft, Download, ExternalLink } from "lucide-react";
import { Link } from "react-router-dom";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { Button } from "../../../components/ui/button";
import {
  StatusBadge,
  type StatusVariant,
} from "../../../components/ui/status-badge";
import { statusLabelForState } from "../../../components/ui/status-badge.helpers";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type { InvoiceDto } from "../types";

interface InvoiceDetailClientProps {
  invoice: InvoiceDto;
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
};

function formatInvoiceDate(value: InvoiceDto["created_at"]): string {
  return new Date(value).toLocaleDateString("en-US", DATE_FORMAT);
}

function formatUsd(value: string | number): string {
  return `$${Number(value).toFixed(2)}`;
}

function invoiceStatusVariant(status: string): StatusVariant {
  if (status === "paid") return "success";
  if (status === "open") return "warning";
  return "danger";
}

export function InvoiceDetailClient({ invoice }: InvoiceDetailClientProps) {
  const t = useCloudT();

  const formattedDate = formatInvoiceDate(invoice.created_at);
  const paidDate = invoice.paid_at ? formatInvoiceDate(invoice.paid_at) : null;
  const invoiceNumber =
    invoice.invoice_number ||
    `INV-${invoice.stripe_invoice_id.slice(-8).toUpperCase()}`;
  const invoiceTypeLabel =
    invoice.invoice_type === "one_time_purchase"
      ? t("cloud.invoiceDetail.oneTimePurchase", {
          defaultValue: "One-time purchase",
        })
      : invoice.invoice_type === "auto_top_up"
        ? t("cloud.invoiceDetail.autoTopUp", {
            defaultValue: "Auto top-up",
          })
        : statusLabelForState(invoice.invoice_type);
  const tableTypeLabel =
    invoice.invoice_type === "one_time_purchase"
      ? t("cloud.invoiceDetail.oneTimeCreditPurchase", {
          defaultValue: "One-Time Credit Purchase",
        })
      : invoice.invoice_type === "auto_top_up"
        ? t("cloud.invoiceDetail.autoTopUp", {
            defaultValue: "Auto top-up",
          })
        : t("cloud.invoiceDetail.creditPurchase", {
            defaultValue: "Credit Purchase",
          });

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <div className="border-b border-border pb-4">
        <Button
          variant="ghost"
          asChild
          className="group flex min-h-touch items-center gap-2 font-mono text-sm text-muted transition-colors hover:text-txt-strong"
        >
          <Link to="/settings#cloud-billing">
            <span className="flex h-8 w-8 items-center justify-center rounded-sm bg-bg-elevated transition-colors group-hover:bg-bg-hover">
              <ArrowLeft className="h-4 w-4" aria-hidden />
            </span>
            <span className="font-medium">
              {t("cloud.invoiceDetail.backToBilling", {
                defaultValue: "Back to billing",
              })}
            </span>
          </Link>
        </Button>
      </div>

      <SettingsStack data-testid="cloud-invoice-detail">
        <SettingsGroup
          title={t("cloud.invoiceDetail.title", {
            defaultValue: "Invoice details",
          })}
          action={
            <div className="flex flex-wrap items-center justify-end gap-2">
              {invoice.invoice_pdf ? (
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                  className="min-h-touch font-mono text-sm underline"
                >
                  <a
                    href={invoice.invoice_pdf}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Download className="h-4 w-4" aria-hidden />
                    {t("cloud.invoiceDetail.downloadPdf", {
                      defaultValue: "Download PDF",
                    })}
                  </a>
                </Button>
              ) : null}
              {invoice.hosted_invoice_url ? (
                <Button
                  variant="ghost"
                  size="sm"
                  asChild
                  className="min-h-touch font-mono text-sm underline"
                >
                  <a
                    href={invoice.hosted_invoice_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink className="h-4 w-4" aria-hidden />
                    {t("cloud.invoiceDetail.viewInStripe", {
                      defaultValue: "View in Stripe",
                    })}
                  </a>
                </Button>
              ) : null}
            </div>
          }
        >
          <SettingsRow
            label={t("cloud.invoiceDetail.invoiceNumber", {
              defaultValue: "Invoice number",
            })}
            description={
              <span className="break-all font-mono text-txt-strong">
                {invoiceNumber}
              </span>
            }
          />
          <SettingsRow
            label={t("cloud.invoiceDetail.date", { defaultValue: "Date" })}
            description={
              <span className="text-txt-strong">{formattedDate}</span>
            }
          />
          <SettingsRow
            label={t("cloud.invoiceDetail.status", { defaultValue: "Status" })}
            control={
              <StatusBadge
                withDot
                variant={invoiceStatusVariant(invoice.status)}
                label={statusLabelForState(invoice.status)}
              />
            }
          />
        </SettingsGroup>

        <BrandCard className="relative">
          <CornerBrackets size="sm" className="opacity-50" />

          <div className="relative z-10 space-y-6">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full bg-accent" aria-hidden />
              <h3 className="font-mono text-base uppercase text-txt-strong">
                {t("cloud.invoiceDetail.transactionSummary", {
                  defaultValue: "Transaction Summary",
                })}
              </h3>
            </div>

            <div className="w-full space-y-0">
              <div className="flex w-full">
                <div className="flex-1 border border-brand-surface bg-card p-4">
                  <p className="font-mono text-sm uppercase text-muted">
                    {t("cloud.invoiceDetail.description", {
                      defaultValue: "Description",
                    })}
                  </p>
                </div>
                <div className="flex-1 border-b border-r border-t border-brand-surface bg-card p-4">
                  <p className="font-mono text-sm uppercase text-muted">
                    {t("cloud.invoiceDetail.amount", {
                      defaultValue: "Amount",
                    })}
                  </p>
                </div>
              </div>

              <div className="flex w-full">
                <div className="flex-1 border-b border-l border-r border-brand-surface bg-card p-4">
                  <p className="font-mono text-base text-txt-strong">
                    {tableTypeLabel}
                  </p>
                </div>
                <div className="flex-1 border-b border-r border-brand-surface bg-card p-4">
                  <p className="font-mono text-base tabular-nums text-txt-strong">
                    {formatUsd(invoice.amount_paid)}
                  </p>
                </div>
              </div>

              {invoice.credits_added ? (
                <div className="flex w-full">
                  <div className="flex-1 border-b border-l border-r border-brand-surface bg-card p-4">
                    <p className="font-mono text-base text-txt-strong">
                      {t("cloud.invoiceDetail.creditsAdded", {
                        defaultValue: "Credits Added",
                      })}
                    </p>
                  </div>
                  <div className="flex-1 border-b border-r border-brand-surface bg-card p-4">
                    <p className="font-mono text-base tabular-nums text-accent">
                      +{formatUsd(invoice.credits_added)}
                    </p>
                  </div>
                </div>
              ) : null}

              {paidDate ? (
                <div className="flex w-full">
                  <div className="flex-1 border-b border-l border-r border-brand-surface bg-card p-4">
                    <p className="font-mono text-base text-txt-strong">
                      {t("cloud.invoiceDetail.paymentDate", {
                        defaultValue: "Payment Date",
                      })}
                    </p>
                  </div>
                  <div className="flex-1 border-b border-r border-brand-surface bg-card p-4">
                    <p className="font-mono text-base text-txt-strong">
                      {paidDate}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </BrandCard>

        <SettingsGroup
          title={t("cloud.invoiceDetail.paymentInformation", {
            defaultValue: "Payment information",
          })}
        >
          <SettingsRow
            label={t("cloud.invoiceDetail.amountDue", {
              defaultValue: "Amount due",
            })}
            description={
              <span className="font-mono tabular-nums text-txt-strong">
                {formatUsd(invoice.amount_due)}
              </span>
            }
          />
          <SettingsRow
            label={t("cloud.invoiceDetail.amountPaid", {
              defaultValue: "Amount paid",
            })}
            description={
              <span className="font-mono tabular-nums text-txt-strong">
                {formatUsd(invoice.amount_paid)}
              </span>
            }
          />
          <SettingsRow
            label={t("cloud.invoiceDetail.currency", {
              defaultValue: "Currency",
            })}
            description={
              <span className="font-mono uppercase text-txt-strong">
                {invoice.currency}
              </span>
            }
          />
          <SettingsRow
            label={t("cloud.invoiceDetail.type", { defaultValue: "Type" })}
            description={
              <span className="text-txt-strong">{invoiceTypeLabel}</span>
            }
          />
          {invoice.stripe_payment_intent_id ? (
            <SettingsRow
              label={t("cloud.invoiceDetail.paymentIntentId", {
                defaultValue: "Payment intent ID",
              })}
              description={
                <span className="break-all font-mono text-txt-strong">
                  {invoice.stripe_payment_intent_id}
                </span>
              }
            />
          ) : null}
        </SettingsGroup>
      </SettingsStack>
    </div>
  );
}
