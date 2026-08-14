/**
 * Invoice detail document: BrandCard header, line items, and payment grid.
 * Header keeps a 3-column readout until the columns no longer fit (collapse
 * late). Flattening it into SettingsRow is a layout regression.
 * Download PDF and View in Stripe are real links.
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/ui/cloud-ui";
import { ArrowLeft, Download, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
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

function InvoiceField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <p className="font-mono text-sm uppercase text-muted">{label}</p>
      <div className="font-mono text-base text-txt-strong">{children}</div>
    </div>
  );
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
          defaultValue: "One-Time Purchase",
        })
      : invoice.invoice_type === "auto_top_up"
        ? t("cloud.invoiceDetail.autoTopUp", {
            defaultValue: "Auto Top-Up",
          })
        : statusLabelForState(invoice.invoice_type);
  const tableTypeLabel =
    invoice.invoice_type === "one_time_purchase"
      ? t("cloud.invoiceDetail.oneTimeCreditPurchase", {
          defaultValue: "One-Time Credit Purchase",
        })
      : invoice.invoice_type === "auto_top_up"
        ? t("cloud.invoiceDetail.autoTopUp", {
            defaultValue: "Auto Top-Up",
          })
        : t("cloud.invoiceDetail.creditPurchase", {
            defaultValue: "Credit Purchase",
          });

  return (
    <div
      className="mx-auto flex max-w-6xl flex-col gap-6 p-6"
      data-testid="cloud-invoice-detail"
    >
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
                defaultValue: "Back to Billing",
              })}
            </span>
          </Link>
        </Button>
      </div>

      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="h-2 w-2 rounded-full bg-accent" aria-hidden />
              <h1 className="font-mono text-2xl uppercase text-txt-strong">
                {t("cloud.invoiceDetail.title", {
                  defaultValue: "Invoice Details",
                })}
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {invoice.invoice_pdf ? (
                <Button
                  variant="ghost"
                  asChild
                  className="flex min-h-touch items-center gap-2 font-mono text-base text-txt-strong underline transition-colors hover:text-accent"
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
                  asChild
                  className="flex min-h-touch items-center gap-2 font-mono text-base text-txt-strong underline transition-colors hover:text-accent"
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
          </div>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
            <InvoiceField
              label={t("cloud.invoiceDetail.invoiceNumber", {
                defaultValue: "Invoice Number",
              })}
            >
              <span className="break-all">{invoiceNumber}</span>
            </InvoiceField>
            <InvoiceField
              label={t("cloud.invoiceDetail.date", { defaultValue: "Date" })}
            >
              {formattedDate}
            </InvoiceField>
            <InvoiceField
              label={t("cloud.invoiceDetail.status", {
                defaultValue: "Status",
              })}
            >
              <StatusBadge
                withDot
                variant={invoiceStatusVariant(invoice.status)}
                label={statusLabelForState(invoice.status)}
              />
            </InvoiceField>
          </div>
        </div>
      </BrandCard>

      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-accent" aria-hidden />
            <h2 className="font-mono text-base uppercase text-txt-strong">
              {t("cloud.invoiceDetail.transactionSummary", {
                defaultValue: "Transaction Summary",
              })}
            </h2>
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
              <div className="flex-1 border-b border-e border-t border-brand-surface bg-card p-4">
                <p className="font-mono text-sm uppercase text-muted">
                  {t("cloud.invoiceDetail.amount", {
                    defaultValue: "Amount",
                  })}
                </p>
              </div>
            </div>

            <div className="flex w-full">
              <div className="flex-1 border-b border-e border-s border-brand-surface bg-card p-4">
                <p className="font-mono text-base text-txt-strong">
                  {tableTypeLabel}
                </p>
              </div>
              <div className="flex-1 border-b border-e border-brand-surface bg-card p-4">
                <p className="font-mono text-base tabular-nums text-txt-strong">
                  {formatUsd(invoice.amount_paid)}
                </p>
              </div>
            </div>

            {invoice.credits_added ? (
              <div className="flex w-full">
                <div className="flex-1 border-b border-e border-s border-brand-surface bg-card p-4">
                  <p className="font-mono text-base text-txt-strong">
                    {t("cloud.invoiceDetail.creditsAdded", {
                      defaultValue: "Credits Added",
                    })}
                  </p>
                </div>
                <div className="flex-1 border-b border-e border-brand-surface bg-card p-4">
                  <p className="font-mono text-base tabular-nums text-accent">
                    +{formatUsd(invoice.credits_added)}
                  </p>
                </div>
              </div>
            ) : null}

            {paidDate ? (
              <div className="flex w-full">
                <div className="flex-1 border-b border-e border-s border-brand-surface bg-card p-4">
                  <p className="font-mono text-base text-txt-strong">
                    {t("cloud.invoiceDetail.paymentDate", {
                      defaultValue: "Payment Date",
                    })}
                  </p>
                </div>
                <div className="flex-1 border-b border-e border-brand-surface bg-card p-4">
                  <p className="font-mono text-base text-txt-strong">
                    {paidDate}
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </BrandCard>

      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center gap-2">
            <div className="h-2 w-2 rounded-full bg-accent" aria-hidden />
            <h2 className="font-mono text-base uppercase text-txt-strong">
              {t("cloud.invoiceDetail.paymentInformation", {
                defaultValue: "Payment Information",
              })}
            </h2>
          </div>

          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <InvoiceField
              label={t("cloud.invoiceDetail.amountDue", {
                defaultValue: "Amount Due",
              })}
            >
              <span className="tabular-nums">
                {formatUsd(invoice.amount_due)}
              </span>
            </InvoiceField>
            <InvoiceField
              label={t("cloud.invoiceDetail.amountPaid", {
                defaultValue: "Amount Paid",
              })}
            >
              <span className="tabular-nums text-accent">
                {formatUsd(invoice.amount_paid)}
              </span>
            </InvoiceField>
            <InvoiceField
              label={t("cloud.invoiceDetail.currency", {
                defaultValue: "Currency",
              })}
            >
              <span className="uppercase">{invoice.currency}</span>
            </InvoiceField>
            <InvoiceField
              label={t("cloud.invoiceDetail.type", { defaultValue: "Type" })}
            >
              {invoiceTypeLabel}
            </InvoiceField>
          </div>

          {invoice.stripe_payment_intent_id ? (
            <div className="border-t border-brand-surface pt-4">
              <InvoiceField
                label={t("cloud.invoiceDetail.paymentIntentId", {
                  defaultValue: "Payment Intent ID",
                })}
              >
                <span className="break-all text-xs text-muted">
                  {invoice.stripe_payment_intent_id}
                </span>
              </InvoiceField>
            </div>
          ) : null}
        </div>
      </BrandCard>
    </div>
  );
}
