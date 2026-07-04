/**
 * Billing body — credit balance, buy-credits (Stripe card + crypto), auto-fund
 * settings, and invoice history. Mounted by the in-app settings billing
 * section. Crypto direct-payments render only when `/api/crypto/status`
 * reports the direct wallet enabled, and the wallet UI is gated behind
 * {@link ConditionalWalletProviders} by the mounting surface.
 */

"use client";

import {
  BrandButton,
  BrandCard,
  CornerBrackets,
  Input,
  Label,
} from "@elizaos/ui/cloud-ui";
import {
  AlertCircle,
  CheckCircle,
  CreditCard,
  Loader2,
  Wallet,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ApiError, api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type {
  BillingUser,
  CreditBalanceResponse,
  CryptoStatusResponse,
  InvoiceDisplay,
} from "../types";
import { AutoTopUpCard } from "./auto-top-up-card";

// Lazy-loaded so its @solana/spl-token + @solana/web3.js imports — which eval
// top-level PublicKey program-id constants through safe-buffer's Buffer() at
// module load — stay OUT of the app boot graph (they crashed boot with
// "Class constructor Buffer cannot be invoked without 'new'"). They now load
// only when the crypto payment UI actually renders, matching the existing
// ConditionalWalletProviders lazy-gating intent.
const DirectCryptoCreditCard = lazy(() =>
  import("./direct-crypto-credit-card").then((m) => ({
    default: m.DirectCryptoCreditCard,
  })),
);

import { Button } from "../../../components/ui/button";
import { PayAsYouGoCard } from "./pay-as-you-go-card";

interface BillingTabProps {
  user: BillingUser;
}

const AMOUNT_LIMITS = {
  MIN: 1,
  MAX: 10000,
} as const;

type PaymentMethod = "card" | "crypto";

export function BillingTab({ user }: BillingTabProps) {
  const t = useCloudT();
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState<InvoiceDisplay[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(true);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [isProcessingCheckout, setIsProcessingCheckout] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  const [cryptoStatus, setCryptoStatus] = useState<CryptoStatusResponse | null>(
    null,
  );

  const [balance, setBalance] = useState(
    Number(user.organization.credit_balance),
  );

  const fetchBalance = useCallback(async (fresh = false) => {
    try {
      const data = await api<CreditBalanceResponse>(
        fresh ? "/api/credits/balance?fresh=true" : "/api/credits/balance",
      );
      setBalance(data.balance);
    } catch {
      // Keep the seeded balance on transient failures.
    }
  }, []);

  const fetchInvoices = useCallback(async () => {
    setLoadingInvoices(true);
    setInvoicesError(null);
    try {
      const data = await api<{ invoices?: InvoiceDisplay[] }>(
        "/api/invoices/list",
      );
      setInvoices(data.invoices ?? []);
    } catch (error) {
      setInvoicesError(
        error instanceof Error
          ? error.message
          : "Invoice history could not be loaded.",
      );
    } finally {
      setLoadingInvoices(false);
    }
  }, []);

  const fetchCryptoStatus = useCallback(async () => {
    try {
      const data = await api<CryptoStatusResponse>("/api/crypto/status");
      setCryptoStatus(data);
    } catch {
      // Crypto is optional; absence just hides the crypto payment path.
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchInvoices();
      void fetchBalance(true);
      void fetchCryptoStatus();
    });
  }, [fetchInvoices, fetchBalance, fetchCryptoStatus]);

  const handleBuyCredits = async () => {
    const amount = parseFloat(purchaseAmount);

    if (Number.isNaN(amount) || amount < AMOUNT_LIMITS.MIN) {
      toast.error(
        t("cloud.billingTab.minAmount", {
          min: AMOUNT_LIMITS.MIN,
          defaultValue: "Minimum amount is $" + "{{min}}",
        }),
      );
      return;
    }

    if (amount > AMOUNT_LIMITS.MAX) {
      toast.error(
        t("cloud.billingTab.maxAmount", {
          max: AMOUNT_LIMITS.MAX,
          defaultValue: "Maximum amount is $" + "{{max}}",
        }),
      );
      return;
    }

    setIsProcessingCheckout(true);

    if (paymentMethod === "crypto" && cryptoStatus?.directWallet?.enabled) {
      // The DirectCryptoCreditCard owns the direct-wallet flow.
      setIsProcessingCheckout(false);
      return;
    }

    if (paymentMethod === "crypto") {
      try {
        const data = await api<{ payLink?: string }>("/api/crypto/payments", {
          method: "POST",
          json: { amount },
        });
        if (!data.payLink) {
          toast.error(
            t("cloud.billingTab.noPaymentLink", {
              defaultValue: "No payment link returned",
            }),
          );
          setIsProcessingCheckout(false);
          return;
        }
        toast.success(
          t("cloud.billingTab.redirectingPayment", {
            defaultValue: "Redirecting to payment page...",
          }),
        );
        window.location.href = data.payLink;
      } catch (error) {
        toast.error(
          error instanceof ApiError
            ? error.message
            : t("cloud.billingTab.createCryptoFailed", {
                defaultValue: "Failed to create crypto payment",
              }),
        );
        setIsProcessingCheckout(false);
      }
      return;
    }

    try {
      const data = await api<{ url?: string }>(
        "/api/stripe/create-checkout-session",
        {
          method: "POST",
          json: { amount, returnUrl: "settings" },
        },
      );
      if (!data.url) {
        toast.error(
          t("cloud.billingTab.noCheckoutUrl", {
            defaultValue: "No checkout URL returned",
          }),
        );
        setIsProcessingCheckout(false);
        return;
      }
      window.location.href = data.url;
    } catch (error) {
      toast.error(
        error instanceof ApiError
          ? error.message
          : t("cloud.billingTab.createCheckoutFailed", {
              defaultValue: "Failed to create checkout session",
            }),
      );
      setIsProcessingCheckout(false);
    }
  };

  const handleViewInvoice = (invoice: InvoiceDisplay) => {
    navigate(`/dashboard/invoices/${invoice.id}`);
  };

  const parsedAmountValue = Number.parseFloat(purchaseAmount);
  const amountValue = Number.isNaN(parsedAmountValue)
    ? null
    : parsedAmountValue;
  const isValidAmount =
    amountValue !== null &&
    amountValue >= AMOUNT_LIMITS.MIN &&
    amountValue <= AMOUNT_LIMITS.MAX;

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      {/* Credit Balance Card */}
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[var(--accent)]" />
            <h3 className="text-base font-mono text-[#e1e1e1] uppercase">
              {t("cloud.billingTab.creditBalance", {
                defaultValue: "Credit Balance",
              })}
            </h3>
          </div>

          <div className="flex flex-col lg:flex-row gap-6 w-full">
            <div className="w-full lg:w-[400px] flex">
              <div className="bg-[rgba(10,10,10,0.75)] border border-brand-surface flex-1 flex items-center justify-center py-6 lg:py-8">
                <div className="flex flex-col items-center justify-center gap-1 px-4">
                  <p className="text-[40px] font-mono text-white tracking-tight">
                    ${balance.toFixed(2)}
                  </p>
                  <p className="text-sm text-white/60 text-center">
                    {t("cloud.billingTab.remainingBalance", {
                      defaultValue: "Remaining balance",
                    })}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex-1 flex flex-col gap-6 lg:justify-center">
              <div className="flex flex-col gap-4">
                <p className="text-base font-mono text-[#e1e1e1]">
                  {t("cloud.billingTab.addCredits", {
                    defaultValue: "Add credits to your account",
                  })}
                </p>
                <p className="text-sm text-white/60">
                  {t("cloud.billingTab.amountHint", {
                    min: AMOUNT_LIMITS.MIN,
                    max: AMOUNT_LIMITS.MAX,
                    defaultValue:
                      "Enter the amount you want to add. Min: $" +
                      "{{min}}" +
                      ", Max: $" +
                      "{{max}}",
                  })}
                </p>

                {cryptoStatus?.enabled && (
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => setPaymentMethod("card")}
                      aria-pressed={paymentMethod === "card"}
                      className={`flex items-center gap-2 px-4 py-2 font-mono text-sm border transition-colors ${
                        paymentMethod === "card"
                          ? "bg-accent border-accent text-accent-foreground"
                          : "bg-transparent border-border text-muted hover:border-border-strong"
                      }`}
                    >
                      <CreditCard className="h-4 w-4" />
                      {t("cloud.billingTab.card", { defaultValue: "Card" })}
                    </Button>
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => setPaymentMethod("crypto")}
                      aria-pressed={paymentMethod === "crypto"}
                      className={`flex items-center gap-2 px-4 py-2 font-mono text-sm border transition-colors ${
                        paymentMethod === "crypto"
                          ? "bg-accent border-accent text-accent-foreground"
                          : "bg-transparent border-border text-muted hover:border-border-strong"
                      }`}
                    >
                      <Wallet className="h-4 w-4" />
                      {t("cloud.billingTab.crypto", { defaultValue: "Crypto" })}
                    </Button>
                  </div>
                )}

                <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-4">
                  <div className="flex-1 max-w-xs">
                    <Label
                      htmlFor="purchase-amount"
                      className="mb-1.5 block text-white/60 font-mono text-xs"
                    >
                      {t("cloud.billingTab.amountLabel", {
                        defaultValue: "Amount (USD)",
                      })}
                    </Label>
                    <div className="relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#717171] font-mono z-10 pointer-events-none">
                        $
                      </span>
                      <Input
                        id="purchase-amount"
                        type="number"
                        step="1"
                        min={AMOUNT_LIMITS.MIN}
                        max={AMOUNT_LIMITS.MAX}
                        value={purchaseAmount}
                        onChange={(e) => setPurchaseAmount(e.target.value)}
                        className="pl-7 bg-[rgba(29,29,29,0.3)] border border-[rgba(255,255,255,0.15)] text-[#e1e1e1] h-11 font-mono"
                        placeholder="0.00"
                        disabled={isProcessingCheckout}
                      />
                    </div>
                  </div>

                  {(paymentMethod !== "crypto" ||
                    !cryptoStatus?.directWallet?.enabled) && (
                    <BrandButton
                      type="button"
                      variant="primary"
                      onClick={handleBuyCredits}
                      disabled={!isValidAmount || isProcessingCheckout}
                      className="h-11 px-6 w-full sm:w-auto flex-shrink-0 font-mono text-base whitespace-nowrap disabled:border disabled:border-white/10 disabled:bg-white/[0.06] disabled:text-white/35 disabled:opacity-100"
                    >
                      {isProcessingCheckout ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" />
                          {t("cloud.billingTab.redirecting", {
                            defaultValue: "Redirecting...",
                          })}
                        </>
                      ) : paymentMethod === "crypto" ? (
                        t("cloud.billingTab.payWithCrypto", {
                          defaultValue: "Pay with Crypto",
                        })
                      ) : (
                        t("cloud.billingTab.buyCredits", {
                          defaultValue: "Buy credits",
                        })
                      )}
                    </BrandButton>
                  )}
                </div>

                {purchaseAmount && !isValidAmount && (
                  <div className="flex items-center gap-2 text-sm text-red-400">
                    <AlertCircle className="h-4 w-4" />
                    <span className="font-mono">
                      {amountValue === null || amountValue < AMOUNT_LIMITS.MIN
                        ? t("cloud.billingTab.minAmount", {
                            min: AMOUNT_LIMITS.MIN,
                            defaultValue: "Minimum amount is $" + "{{min}}",
                          })
                        : t("cloud.billingTab.maxAmount", {
                            max: AMOUNT_LIMITS.MAX,
                            defaultValue: "Maximum amount is $" + "{{max}}",
                          })}
                    </span>
                  </div>
                )}

                {isValidAmount && purchaseAmount && amountValue !== null && (
                  <div className="flex items-center gap-2 text-sm text-green-400">
                    <CheckCircle className="h-4 w-4" />
                    <span className="font-mono">
                      {t("cloud.billingTab.willBeAdded", {
                        amount: amountValue.toFixed(2),
                        defaultValue:
                          "$" + "{{amount}}" + " will be added to your balance",
                      })}
                    </span>
                  </div>
                )}

                {paymentMethod === "crypto" &&
                  cryptoStatus?.directWallet?.enabled && (
                    <Suspense fallback={null}>
                      <DirectCryptoCreditCard
                        amount={amountValue}
                        status={cryptoStatus}
                        accountWalletAddress={user.wallet_address ?? null}
                        onSuccess={async () => {
                          await fetchBalance(true);
                          await fetchInvoices();
                        }}
                      />
                    </Suspense>
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
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-[var(--accent)]" />
              <h3 className="text-base font-mono text-[#e1e1e1] uppercase">
                {t("cloud.billingTab.invoices", { defaultValue: "Invoices" })}
              </h3>
            </div>
            <p className="text-xs font-mono text-[#858585] tracking-tight">
              {t("cloud.billingTab.invoicesDesc", {
                defaultValue:
                  "View your payment history and download invoices.",
              })}
            </p>
          </div>

          <div className="w-full overflow-x-auto">
            <div className="min-w-[600px]">
              <div className="flex w-full">
                <div className="bg-[rgba(10,10,10,0.75)] border border-brand-surface flex-[1.5] p-3 md:p-4">
                  <p className="text-xs md:text-sm font-mono font-bold text-white uppercase">
                    {t("cloud.billingTab.colDateTime", {
                      defaultValue: "Date & Time",
                    })}
                  </p>
                </div>
                <div className="bg-[rgba(10,10,10,0.75)] border-t border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                  <p className="text-xs md:text-sm font-mono font-bold text-white uppercase">
                    {t("cloud.billingTab.colTotal", { defaultValue: "Total" })}
                  </p>
                </div>
                <div className="bg-[rgba(10,10,10,0.75)] border-t border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                  <p className="text-xs md:text-sm font-mono font-bold text-white uppercase">
                    {t("cloud.billingTab.colStatus", {
                      defaultValue: "Status",
                    })}
                  </p>
                </div>
                <div className="bg-[rgba(10,10,10,0.75)] border-t border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                  <p className="text-xs md:text-sm font-mono font-bold text-white uppercase">
                    {t("cloud.billingTab.colActions", {
                      defaultValue: "Actions",
                    })}
                  </p>
                </div>
              </div>

              {loadingInvoices ? (
                <div className="flex items-center justify-center p-8 border-l border-r border-b border-brand-surface">
                  <Loader2 className="h-6 w-6 animate-spin text-[var(--accent)]" />
                </div>
              ) : invoicesError ? (
                <div className="flex items-start gap-3 p-8 border-l border-r border-b border-brand-surface bg-red-500/5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                  <div className="space-y-1">
                    <p className="text-xs md:text-sm text-red-300 font-mono">
                      {t("cloud.billingTab.invoiceLoadFailed", {
                        defaultValue: "Invoice history could not be loaded",
                      })}
                    </p>
                    <p className="text-xs text-white/45 font-mono">
                      {invoicesError}
                    </p>
                  </div>
                </div>
              ) : invoices.length === 0 ? (
                <div className="flex items-center justify-center p-8 border-l border-r border-b border-brand-surface">
                  <p className="text-xs md:text-sm text-white/60 font-mono">
                    {t("cloud.billingTab.noInvoices", {
                      defaultValue: "No invoices yet",
                    })}
                  </p>
                </div>
              ) : (
                invoices.map((invoice) => (
                  <div key={invoice.id} className="flex w-full">
                    <div className="bg-[rgba(10,10,10,0.75)] border-l border-r border-b border-brand-surface flex-[1.5] p-3 md:p-4">
                      <p className="text-xs md:text-sm font-mono text-white">
                        {invoice.date}
                      </p>
                    </div>
                    <div className="bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                      <p className="text-xs md:text-sm font-mono text-white uppercase">
                        {invoice.total}
                      </p>
                    </div>
                    <div className="bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                      <p className="text-xs md:text-sm font-mono text-white uppercase">
                        {invoice.status}
                      </p>
                    </div>
                    <div className="bg-[rgba(10,10,10,0.75)] border-r border-b border-brand-surface flex-1 p-3 md:p-4">
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => handleViewInvoice(invoice)}
                        className="text-xs md:text-sm font-mono text-white underline uppercase hover:text-white/80 transition-colors"
                      >
                        {t("cloud.billingTab.view", { defaultValue: "View" })}
                      </Button>
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

export type { BillingUser };
