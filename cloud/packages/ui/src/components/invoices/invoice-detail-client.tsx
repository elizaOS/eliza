/**
 * Invoice detail client component displaying full invoice information.
 * Shows invoice details, line items, payment status, and provides download/view links.
 *
 * @param props - Invoice detail client configuration
 * @param props.invoice - Invoice data to display
 */

"use client";

import { BrandCard, CornerBrackets } from "@elizaos/cloud-ui";
import { ArrowLeft, Download, ExternalLink } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { InvoiceDto } from "@/types/cloud-api";

interface InvoiceDetailClientProps {
  invoice: InvoiceDto;
}

export function InvoiceDetailClient({ invoice }: InvoiceDetailClientProps) {
  const navigate = useNavigate();

  const formattedDate = new Date(invoice.created_at).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const paidDate = invoice.paid_at
    ? new Date(invoice.paid_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
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
          onClick={() => navigate("/dashboard/settings?tab=billing")}
          className="group flex items-center gap-2 text-sm text-white/70 hover:text-white transition-all duration-200"
          style={{ fontFamily: "var(--font-roboto-mono)" }}
        >
          <div className="flex items-center justify-center w-8 h-8 rounded-lg border border-white/10 bg-black/40 group-hover:bg-white/5 group-hover:border-[#FF5800]/50 transition-all duration-200">
            <ArrowLeft className="h-4 w-4" />
          </div>
          <span className="font-medium">Back to Billing</span>
        </button>
      </div>

      {/* Invoice Header Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
              <h1 className="text-2xl font-mono text-[#e1e1e1] uppercase">Invoice Details</h1>
            </div>
            <div className="flex items-center gap-3">
              {invoice.invoice_pdf && (
                <button
                  type="button"
                  onClick={() => invoice.invoice_pdf && window.open(invoice.invoice_pdf, "_blank")}
                  className="flex items-center gap-2 text-base font-mono text-white underline hover:text-white/80 transition-colors"
                >
                  <Download className="h-4 w-4" />
                  Download PDF
                </button>
              )}
              {invoice.hosted_invoice_url && (
                <button
                  type="button"
                  onClick={() =>
                    invoice.hosted_invoice_url && window.open(invoice.hosted_invoice_url, "_blank")
                  }
                  className="flex items-center gap-2 text-base font-mono text-white underline hover:text-white/80 transition-colors"
                >
                  <ExternalLink className="h-4 w-4" />
                  View in Stripe
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-6">
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">Invoice Number</p>
              <p className="text-base font-mono text-white">
                {invoice.invoice_number ||
                  `INV-${invoice.stripe_invoice_id.slice(-8).toUpperCase()}`}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">Date</p>
              <p className="text-base font-mono text-white">{formattedDate}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">Status</p>
              <p className={`text-base font-mono uppercase ${statusColor}`}>{invoice.status}</p>
            </div>
          </div>
        </div>
      </BrandCard>

      {/* Transaction Summary Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
            <h2 className="text-base font-mono text-[#e1e1e1] uppercase">Transaction Summary</h2>
          </div>

          <div className="space-y-0 w-full">
            <div className="flex w-full">
              <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface flex-1 p-4">
                <p className="text-sm font-mono text-white/60 uppercase">Description</p>
              </div>
              <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t border-r border-b border-brand-surface flex-1 p-4">
                <p className="text-sm font-mono text-white/60 uppercase">Amount</p>
              </div>
            </div>

            <div className="flex w-full">
              <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-l border-r border-b border-brand-surface flex-1 p-4">
                <p className="text-base font-mono text-white">
                  {invoice.invoice_type === "one_time_purchase"
                    ? "One-Time Credit Purchase"
                    : invoice.invoice_type === "auto_top_up"
                      ? "Auto Top-Up"
                      : "Credit Purchase"}
                </p>
              </div>
              <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-4">
                <p className="text-base font-mono text-white">
                  ${Number(invoice.amount_paid).toFixed(2)}
                </p>
              </div>
            </div>

            {invoice.credits_added && (
              <div className="flex w-full">
                <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-l border-r border-b border-brand-surface flex-1 p-4">
                  <p className="text-base font-mono text-white">Credits Added</p>
                </div>
                <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-4">
                  <p className="text-base font-mono text-[#FF5800]">
                    +${Number(invoice.credits_added).toFixed(2)}
                  </p>
                </div>
              </div>
            )}

            {paidDate && (
              <div className="flex w-full">
                <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-l border-r border-b border-brand-surface flex-1 p-4">
                  <p className="text-base font-mono text-white">Payment Date</p>
                </div>
                <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-4">
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
            <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
            <h2 className="text-base font-mono text-[#e1e1e1] uppercase">Payment Information</h2>
          </div>

          <div className="grid grid-cols-2 gap-6">
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">Amount Due</p>
              <p className="text-base font-mono text-white">
                ${Number(invoice.amount_due).toFixed(2)}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">Amount Paid</p>
              <p className="text-base font-mono text-[#FF5800]">
                ${Number(invoice.amount_paid).toFixed(2)}
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">Currency</p>
              <p className="text-base font-mono text-white uppercase">{invoice.currency}</p>
            </div>
            <div className="space-y-2">
              <p className="text-sm font-mono text-white/60 uppercase">Type</p>
              <p className="text-base font-mono text-white">
                {invoice.invoice_type === "one_time_purchase"
                  ? "One-Time Purchase"
                  : invoice.invoice_type === "auto_top_up"
                    ? "Auto Top-Up"
                    : invoice.invoice_type}
              </p>
            </div>
          </div>

          {invoice.stripe_payment_intent_id && (
            <div className="border-t border-brand-surface pt-4">
              <div className="space-y-2">
                <p className="text-sm font-mono text-white/60 uppercase">Payment Intent ID</p>
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
