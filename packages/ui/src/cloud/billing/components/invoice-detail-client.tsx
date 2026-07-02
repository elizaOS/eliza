/**
 * Invoice detail view — full invoice info, line items, payment status, and
 * download/view links.
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/ui/cloud-ui";
import { ArrowLeft, Download, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";
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

export function InvoiceDetailClient({ invoice }: InvoiceDetailClientProps) {
  const t = useCloudT();
  const navigate = useNavigate();

  const formattedDate = new Date(invoice.created_at).toLocaleDateString(
    "en-US",
    DATE_FORMAT,
  );

  const paidDate = invoice.paid_at
    ? new Date(invoice.paid_at).toLocaleDateString("en-US", DATE_FORMAT)
    : null;

  const statusColor =
    invoice.status === "paid"
      ? "text-green-500"
      : invoice.status === "open"
        ? "text-yellow-500"
        : "text-red-500";

  return (
    <div className="flex flex-col gap-6 max-w-6xl mx-auto p-6">
      {/* Back Navigation */}
      <div className="border-b border-white/10 pb-4">
        <button
          type="button"
          onClick={() => navigate("/settings#cloud-billing")}
          className="group flex items-center gap-2 text-sm text-white/70 hover:text-white transition-all duration-200"
          style={{ fontFamily: "var(--font-roboto-mono)" }}
        >
          <div className="flex items-center justify-center w-8 h-8 rounded-sm bg-black/40 group-hover:bg-white/10 transition-all duration-200">
            <ArrowLeft className="h-4 w-4" />
          </div>
          <span className="font-medium">
            {t("cloud.invoiceDetail.backToBilling", {
              defaultValue: "Back to Billing",
            })}
          </span>
        </button>
      </div>

      {/* Invoice Header Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-[var(--brand-orange)]" />
              <h1 className="text-2xl font-mono text-[#e1e1e1] uppercase">
                {t("cloud.invoiceDetail.title", {
                  defaultValue: "Invoice Details",
                })}
              </h1>
            </div>
            <div className="flex items-center gap-3">
              {invoice.invoice_pdf && (
                <button
                  type="button"
                  onClick={() =>
                    invoice.invoice_pdf &&
                    window.open(invoice.invoice_pdf, "_blank")
                  }
                  className="flex items-center gap-2 text-base font-mono text-white underline hover:text-white/80 transition-colors"
                >
                  <Download className="h-4 w-4" />
                  {t("cloud.invoiceDetail.downloadPdf", {
                    defaultValue: "Download PDF",
                  })}
                </button>
              )}
              {invoice.hosted_invoice_url && (
                <button
                  type="button"
                  onClick={() =>
                    invoice.hosted_invoice_url &&
                    window.open(invoice.hosted_invoice_url, "_blank")
                  }
                  className="flex items-center gap-2 text-base font-mono text-white underline hover:text-white/80 transition-colors"
                >
                  <ExternalLink className="h-4 w-4" />
                  {t("cloud.invoiceDetail.viewInStripe", {
                    defaultValue: "View in Stripe",
                  })}
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-6">
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">
                {t("cloud.invoiceDetail.invoiceNumber", {
                  defaultValue: "Invoice Number",
                })}
              </p>
              <p className="text-base font-mono text-white">
                {invoice.invoice_number ||
                  `INV-${invoice.stripe_invoice_id.slice(-8).toUpperCase()}`}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">
                {t("cloud.invoiceDetail.date", { defaultValue: "Date" })}
              </p>
              <p className="text-base font-mono text-white">{formattedDate}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">
                {t("cloud.invoiceDetail.status", { defaultValue: "Status" })}
              </p>
              <p className={`text-base font-mono uppercase ${statusColor}`}>
                {invoice.status}
              </p>
            </div>
          </div>
        </div>
      </BrandCard>

      {/* Transaction Summary Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[var(--brand-orange)]" />
            <h2 className="text-base font-mono text-[#e1e1e1] uppercase">
              {t("cloud.invoiceDetail.transactionSummary", {
                defaultValue: "Transaction Summary",
              })}
            </h2>
          </div>

          <div className="space-y-0 w-full">
            <div className="flex w-full">
              <div className="bg-[rgba(10,10,10,0.75)] border border-brand-surface flex-1 p-4">
                <p className="text-sm font-mono text-white/60 uppercase">
                  {t("cloud.invoiceDetail.description", {
                    defaultValue: "Description",
                  })}
                </p>
              </div>
              <div className="bg-[rgba(10,10,10,0.75)] border-t border-r border-b border-brand-surface flex-1 p-4">
                <p className="text-sm font-mono text-white/60 uppercase">
                  {t("cloud.invoiceDetail.amount", { defaultValue: "Amount" })}
                </p>
              </div>
            </div>

            <div className="flex w-full">
              <div className="bg-[rgba(10,10,10,0.75)] border-l border-r border-b border-brand-surface flex-1 p-4">
                <p className="text-base font-mono text-white">
                  {invoice.invoice_type === "one_time_purchase"
                    ? t("cloud.invoiceDetail.oneTimeCreditPurchase", {
                        defaultValue: "One-Time Credit Purchase",
                      })
                    : invoice.invoice_type === "auto_top_up"
                      ? t("cloud.invoiceDetail.autoTopUp", {
                          defaultValue: "Auto Top-Up",
                        })
                      : t("cloud.invoiceDetail.creditPurchase", {
                          defaultValue: "Credit Purchase",
                        })}
                </p>
              </div>
              <div className="bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-4">
                <p className="text-base font-mono text-white">
                  ${Number(invoice.amount_paid).toFixed(2)}
                </p>
              </div>
            </div>

            {invoice.credits_added && (
              <div className="flex w-full">
                <div className="bg-[rgba(10,10,10,0.75)] border-l border-r border-b border-brand-surface flex-1 p-4">
                  <p className="text-base font-mono text-white">
                    {t("cloud.invoiceDetail.creditsAdded", {
                      defaultValue: "Credits Added",
                    })}
                  </p>
                </div>
                <div className="bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-4">
                  <p className="text-base font-mono text-[var(--brand-orange)]">
                    +${Number(invoice.credits_added).toFixed(2)}
                  </p>
                </div>
              </div>
            )}

            {paidDate && (
              <div className="flex w-full">
                <div className="bg-[rgba(10,10,10,0.75)] border-l border-r border-b border-brand-surface flex-1 p-4">
                  <p className="text-base font-mono text-white">
                    {t("cloud.invoiceDetail.paymentDate", {
                      defaultValue: "Payment Date",
                    })}
                  </p>
                </div>
                <div className="bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-4">
                  <p className="text-base font-mono text-white">{paidDate}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </BrandCard>

      {/* Payment Information Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[var(--brand-orange)]" />
            <h2 className="text-base font-mono text-[#e1e1e1] uppercase">
              {t("cloud.invoiceDetail.paymentInformation", {
                defaultValue: "Payment Information",
              })}
            </h2>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">
                {t("cloud.invoiceDetail.amountDue", {
                  defaultValue: "Amount Due",
                })}
              </p>
              <p className="text-base font-mono text-white">
                ${Number(invoice.amount_due).toFixed(2)}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">
                {t("cloud.invoiceDetail.amountPaid", {
                  defaultValue: "Amount Paid",
                })}
              </p>
              <p className="text-base font-mono text-[var(--brand-orange)]">
                ${Number(invoice.amount_paid).toFixed(2)}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">
                {t("cloud.invoiceDetail.currency", {
                  defaultValue: "Currency",
                })}
              </p>
              <p className="text-base font-mono text-white uppercase">
                {invoice.currency}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">
                {t("cloud.invoiceDetail.type", { defaultValue: "Type" })}
              </p>
              <p className="text-base font-mono text-white">
                {invoice.invoice_type === "one_time_purchase"
                  ? t("cloud.invoiceDetail.oneTimePurchase", {
                      defaultValue: "One-Time Purchase",
                    })
                  : invoice.invoice_type === "auto_top_up"
                    ? t("cloud.invoiceDetail.autoTopUp", {
                        defaultValue: "Auto Top-Up",
                      })
                    : invoice.invoice_type}
              </p>
            </div>
          </div>

          {invoice.stripe_payment_intent_id && (
            <div className="border-t border-brand-surface pt-4">
              <div className="space-y-2">
                <p className="text-sm font-mono text-white/60 uppercase">
                  {t("cloud.invoiceDetail.paymentIntentId", {
                    defaultValue: "Payment Intent ID",
                  })}
                </p>
                <p className="text-xs font-mono text-white/40 break-all">
                  {invoice.stripe_payment_intent_id}
                </p>
              </div>
            </div>
          )}
        </div>
      </BrandCard>
    </div>
  );
}
