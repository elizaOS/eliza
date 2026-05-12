/**
 * Billing settings tab component for managing credit balance and invoices.
 * Supports credit purchases, invoice viewing, and balance management.
 *
 * @param props - Billing tab configuration
 * @param props.user - User data with organization information
 */

"use client";

import { BrandCard, CornerBrackets, Input } from "@elizaos/cloud-ui";
import { AlertCircle, CheckCircle, CreditCard, Loader2, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { CryptoStatusResponse } from "@/lib/types/crypto-status";
import { AutoTopUpCard } from "../../../billing/_components/auto-top-up-card";
import { PayAsYouGoCard } from "../../../billing/_components/pay-as-you-go-card";

export interface BillingUser {
  organization_id: string | null;
  organization: {
    credit_balance: string | number;
  } | null;
}

interface BillingTabProps {
  user: BillingUser;
}

interface InvoiceDisplay {
  id: string;
  stripeInvoiceId?: string;
  date: string;
  total: string;
  status: string;
  invoiceUrl?: string;
  invoicePdf?: string;
  type?: string;
  creditsAdded?: number;
}

const AMOUNT_LIMITS = {
  MIN: 1,
  MAX: 10000,
} as const;

type PaymentMethod = "card" | "crypto";

export function BillingTab({ user }: BillingTabProps) {
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState<InvoiceDisplay[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(true);
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [isProcessingCheckout, setIsProcessingCheckout] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  const [cryptoStatus, setCryptoStatus] = useState<CryptoStatusResponse | null>(null);

  const [balance, setBalance] = useState(Number(user.organization?.credit_balance ?? 0));

  const fetchBalance = useCallback(async (fresh = false) => {
    const url = fresh ? "/api/credits/balance?fresh=true" : "/api/credits/balance";
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      setBalance(data.balance);
    }
  }, []);

  const fetchInvoices = useCallback(async () => {
    setLoadingInvoices(true);
    const response = await fetch("/api/invoices/list");
    if (response.ok) {
      const data = await response.json();
      setInvoices(data.invoices || []);
    } else {
      setInvoices([]);
    }
    setLoadingInvoices(false);
  }, []);

  const fetchCryptoStatus = useCallback(async () => {
    const response = await fetch("/api/crypto/status");
    if (response.ok) {
      const data: CryptoStatusResponse = await response.json();
      setCryptoStatus(data);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      fetchInvoices();
      // Fetch fresh balance on billing tab load (user may have just returned from payment)
      fetchBalance(true);
      fetchCryptoStatus();
    });
  }, [fetchInvoices, fetchBalance, fetchCryptoStatus]);

  const handleBuyCredits = async () => {
    const amount = parseFloat(purchaseAmount);

    if (isNaN(amount) || amount < AMOUNT_LIMITS.MIN) {
      toast.error(`Minimum amount is $${AMOUNT_LIMITS.MIN}`);
      return;
    }

    if (amount > AMOUNT_LIMITS.MAX) {
      toast.error(`Maximum amount is $${AMOUNT_LIMITS.MAX}`);
      return;
    }

    // Note: checkout_initiated is tracked server-side after successful session creation
    // to avoid inflated metrics from failed API calls

    setIsProcessingCheckout(true);

    if (paymentMethod === "crypto") {
      try {
        const response = await fetch("/api/crypto/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          toast.error(errorData.error || "Failed to create payment");
          setIsProcessingCheckout(false);
          return;
        }

        const data = await response.json();

        if (!data.payLink) {
          toast.error("No payment link returned");
          setIsProcessingCheckout(false);
          return;
        }

        toast.success("Redirecting to payment page...");
        window.location.href = data.payLink;
      } catch (error) {
        console.error("Failed to create crypto payment:", error);
        toast.error("Failed to create crypto payment");
        setIsProcessingCheckout(false);
      }
      return;
    }

    const response = await fetch("/api/stripe/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount,
        returnUrl: "settings",
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      toast.error(errorData.error || "Failed to create checkout session");
      setIsProcessingCheckout(false);
      return;
    }

    const data = await response.json();
    const { url } = data;

    if (!url) {
      toast.error("No checkout URL returned");
      setIsProcessingCheckout(false);
      return;
    }

    window.location.href = url;
  };

  const handleViewInvoice = (invoice: InvoiceDisplay) => {
    navigate(`/dashboard/invoices/${invoice.id}`);
  };

  const parsedAmountValue = Number.parseFloat(purchaseAmount);
  const amountValue = Number.isNaN(parsedAmountValue) ? null : parsedAmountValue;
  const isValidAmount =
    amountValue !== null && amountValue >= AMOUNT_LIMITS.MIN && amountValue <= AMOUNT_LIMITS.MAX;

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* Credit Balance Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          {/* Header */}
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
            <h3 className="text-base font-mono text-[#e1e1e1] uppercase">Credit Balance</h3>
          </div>

          {/* Content Grid */}
          <div className="flex flex-col lg:flex-row gap-6 w-full">
            {/* Balance Display */}
            <div className="w-full lg:w-[400px] flex">
              <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface flex-1 flex items-center justify-center py-6 lg:py-8">
                <div className="flex flex-col items-center justify-center gap-1 px-4">
                  <p className="text-[40px] font-mono text-white tracking-tight">
                    ${balance.toFixed(2)}
                  </p>
                  <p className="text-sm text-white/60 text-center">Remaining balance</p>
                </div>
              </div>
            </div>

            {/* Right Section - Buy Credits */}
            <div className="flex-1 flex flex-col gap-6 lg:justify-center">
              <div className="flex flex-col gap-4">
                <p className="text-base font-mono text-[#e1e1e1]">Add credits to your account</p>
                <p className="text-sm text-white/60">
                  Enter the amount you want to add. Min: ${AMOUNT_LIMITS.MIN}, Max: $
                  {AMOUNT_LIMITS.MAX}
                </p>

                {cryptoStatus?.enabled && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setPaymentMethod("card");
                      }}
                      className={`flex items-center gap-2 px-4 py-2 font-mono text-sm border transition-colors ${
                        paymentMethod === "card"
                          ? "bg-[#FF5800] border-[#FF5800] text-white"
                          : "bg-transparent border-[rgba(255,255,255,0.2)] text-white/60 hover:border-[rgba(255,255,255,0.4)]"
                      }`}
                    >
                      <CreditCard className="h-4 w-4" />
                      Card
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPaymentMethod("crypto");
                      }}
                      className={`flex items-center gap-2 px-4 py-2 font-mono text-sm border transition-colors ${
                        paymentMethod === "crypto"
                          ? "bg-[#FF5800] border-[#FF5800] text-white"
                          : "bg-transparent border-[rgba(255,255,255,0.2)] text-white/60 hover:border-[rgba(255,255,255,0.4)]"
                      }`}
                    >
                      <Wallet className="h-4 w-4" />
                      Crypto
                    </button>
                  </div>
                )}

                {/* Amount Input and Buy Button */}
                <div className="flex flex-col sm:flex-row items-stretch gap-4">
                  {/* Amount Input */}
                  <div className="relative flex-1 max-w-xs">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#717171] font-mono z-10 pointer-events-none">
                      $
                    </span>
                    <Input
                      type="number"
                      step="1"
                      min={AMOUNT_LIMITS.MIN}
                      max={AMOUNT_LIMITS.MAX}
                      value={purchaseAmount}
                      onChange={(e) => setPurchaseAmount(e.target.value)}
                      className="pl-7 backdrop-blur-sm bg-[rgba(29,29,29,0.3)] border border-[rgba(255,255,255,0.15)] text-[#e1e1e1] h-11 font-mono"
                      placeholder="0.00"
                      disabled={isProcessingCheckout}
                    />
                  </div>

                  {/* Buy Credits Button */}
                  <button
                    type="button"
                    onClick={handleBuyCredits}
                    disabled={!isValidAmount || isProcessingCheckout}
                    className="relative bg-[#e1e1e1] px-6 py-2.5 overflow-hidden hover:bg-white transition-colors w-full sm:w-auto flex-shrink-0 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    <div
                      className="absolute inset-0 opacity-20 bg-repeat pointer-events-none"
                      style={{
                        backgroundImage: `url(/assets/settings/pattern-6px-flip.png)`,
                        backgroundSize: "2.915576934814453px 2.915576934814453px",
                      }}
                    />
                    {isProcessingCheckout ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin text-black relative z-10" />
                        <span className="relative z-10 text-black font-mono font-medium text-base whitespace-nowrap">
                          Redirecting...
                        </span>
                      </>
                    ) : (
                      <span className="relative z-10 text-black font-mono font-medium text-base whitespace-nowrap">
                        {paymentMethod === "crypto" ? "Pay with Crypto" : "Buy credits"}
                      </span>
                    )}
                  </button>
                </div>

                {/* Amount validation feedback */}
                {purchaseAmount && !isValidAmount && (
                  <div className="flex items-center gap-2 text-sm text-red-400">
                    <AlertCircle className="h-4 w-4" />
                    <span className="font-mono">
                      {amountValue === null || amountValue < AMOUNT_LIMITS.MIN
                        ? `Minimum amount is $${AMOUNT_LIMITS.MIN}`
                        : `Maximum amount is $${AMOUNT_LIMITS.MAX}`}
                    </span>
                  </div>
                )}

                {isValidAmount && purchaseAmount && amountValue !== null && (
                  <div className="flex items-center gap-2 text-sm text-green-400">
                    <CheckCircle className="h-4 w-4" />
                    <span className="font-mono">
                      ${amountValue.toFixed(2)} will be added to your balance
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </BrandCard>

      {/* Pay-as-you-go from earnings — toggle for whether app earnings absorb container bills */}
      <PayAsYouGoCard />

      {/* Card Auto Top-Up — backstop when both earnings + credits run low */}
      <AutoTopUpCard />

      {/* Invoices Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          {/* Header */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
              <h3 className="text-base font-mono text-[#e1e1e1] uppercase">Invoices</h3>
            </div>
            <p className="text-xs font-mono text-[#858585] tracking-tight">
              View your payment history and download invoices.
            </p>
          </div>

          {/* Table */}
          <div className="w-full overflow-x-auto">
            <div className="min-w-[600px]">
              {/* Table Header */}
              <div className="flex w-full">
                <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border border-brand-surface flex-[1.5] p-3 md:p-4">
                  <p className="text-xs md:text-sm font-mono font-bold text-white uppercase">
                    Date & Time
                  </p>
                </div>
                <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                  <p className="text-xs md:text-sm font-mono font-bold text-white uppercase">
                    Total
                  </p>
                </div>
                <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                  <p className="text-xs md:text-sm font-mono font-bold text-white uppercase">
                    Status
                  </p>
                </div>
                <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-t border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                  <p className="text-xs md:text-sm font-mono font-bold text-white uppercase">
                    Actions
                  </p>
                </div>
              </div>

              {/* Table Rows */}
              {loadingInvoices ? (
                <div className="flex items-center justify-center p-8 border-l border-r border-b border-brand-surface">
                  <Loader2 className="h-6 w-6 animate-spin text-[#FF5800]" />
                </div>
              ) : invoices.length === 0 ? (
                <div className="flex items-center justify-center p-8 border-l border-r border-b border-brand-surface">
                  <p className="text-xs md:text-sm text-white/60 font-mono">No invoices yet</p>
                </div>
              ) : (
                invoices.map((invoice) => (
                  <div key={invoice.id} className="flex w-full">
                    <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-l border-r border-b border-brand-surface flex-[1.5] p-3 md:p-4">
                      <p className="text-xs md:text-sm font-mono text-white">{invoice.date}</p>
                    </div>
                    <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                      <p className="text-xs md:text-sm font-mono text-white uppercase">
                        {invoice.total}
                      </p>
                    </div>
                    <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                      <p className="text-xs md:text-sm font-mono text-white uppercase">
                        {invoice.status}
                      </p>
                    </div>
                    <div className="backdrop-blur-sm bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                      <button
                        type="button"
                        onClick={() => handleViewInvoice(invoice)}
                        className="text-xs md:text-sm font-mono text-white underline uppercase hover:text-white/80 transition-colors"
                      >
                        View
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </BrandCard>
    </div>
  );
}
