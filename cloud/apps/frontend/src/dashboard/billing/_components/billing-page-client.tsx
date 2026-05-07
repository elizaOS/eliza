/**
 * Billing page client component for adding funds via card or crypto.
 *
 * @param props - Billing page configuration
 * @param props.currentCredits - User's current credit balance
 */

"use client";

import { BrandCard, CornerBrackets, Input } from "@elizaos/cloud-ui";
import { AlertCircle, CheckCircle, CreditCard, Loader2, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { CryptoStatusResponse } from "@/lib/types/crypto-status";

interface BillingPageClientProps {
  currentCredits: number;
}

const AMOUNT_LIMITS = {
  MIN: 1,
  MAX: 10000,
} as const;

type PaymentMethod = "card" | "crypto";

export function BillingPageClient({ currentCredits }: BillingPageClientProps) {
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [isProcessingCheckout, setIsProcessingCheckout] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  const [cryptoStatus, setCryptoStatus] = useState<CryptoStatusResponse | null>(null);
  const [balance, _setBalance] = useState(currentCredits);

  const fetchCryptoStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/crypto/status");
      if (response.ok) {
        const data: CryptoStatusResponse = await response.json();
        setCryptoStatus(data);
      }
    } catch {
      // crypto status unavailable, card-only mode
    }
  }, []);

  useEffect(() => {
    fetchCryptoStatus();
  }, [fetchCryptoStatus]);

  const handleAddFunds = async () => {
    const amount = parseFloat(purchaseAmount);

    if (isNaN(amount) || amount < AMOUNT_LIMITS.MIN) {
      toast.error(`Minimum amount is $${AMOUNT_LIMITS.MIN}`);
      return;
    }
    if (amount > AMOUNT_LIMITS.MAX) {
      toast.error(`Maximum amount is $${AMOUNT_LIMITS.MAX}`);
      return;
    }

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
      } catch {
        toast.error("Failed to create crypto payment");
        setIsProcessingCheckout(false);
      }
      return;
    }

    // Card / Stripe
    const response = await fetch("/api/stripe/create-checkout-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, returnUrl: "billing" }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      toast.error(errorData.error || "Failed to create checkout session");
      setIsProcessingCheckout(false);
      return;
    }

    const { url } = await response.json();

    if (!url) {
      toast.error("No checkout URL returned");
      setIsProcessingCheckout(false);
      return;
    }

    window.location.href = url;
  };

  const amountValue = parseFloat(purchaseAmount) || 0;
  const isValidAmount = amountValue >= AMOUNT_LIMITS.MIN && amountValue <= AMOUNT_LIMITS.MAX;

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />

      <div className="relative z-10 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
            <h3 className="text-base font-mono text-[#e1e1e1] uppercase">Add Funds</h3>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-white/40 uppercase">Balance</span>
            <span className="text-2xl font-mono text-white">${balance.toFixed(2)}</span>
          </div>
        </div>

        {/* Payment Method Toggle (only shown when crypto is enabled) */}
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

        {/* Amount Input + Button */}
        <div className="flex flex-col sm:flex-row items-stretch gap-4">
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

          <button
            type="button"
            onClick={handleAddFunds}
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
                {paymentMethod === "crypto" ? "Pay with Crypto" : "Add Funds"}
              </span>
            )}
          </button>
        </div>

        {/* Validation feedback */}
        {purchaseAmount && !isValidAmount && (
          <div className="flex items-center gap-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4" />
            <span className="font-mono">
              {amountValue < AMOUNT_LIMITS.MIN
                ? `Minimum amount is $${AMOUNT_LIMITS.MIN}`
                : `Maximum amount is $${AMOUNT_LIMITS.MAX}`}
            </span>
          </div>
        )}

        {isValidAmount && purchaseAmount && (
          <div className="flex items-center gap-2 text-sm text-green-400">
            <CheckCircle className="h-4 w-4" />
            <span className="font-mono">
              ${amountValue.toFixed(2)} will be added to your balance
            </span>
          </div>
        )}
      </div>
    </BrandCard>
  );
}
