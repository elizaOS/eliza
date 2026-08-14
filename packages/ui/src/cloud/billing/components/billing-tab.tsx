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
  XCircle,
} from "lucide-react";
import {
  type FormEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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

type InvoiceStatusTone = "success" | "warning" | "danger";

function invoiceStatusTone(status: string): InvoiceStatusTone {
  const normalized = status.trim().toLowerCase();
  if (
    normalized === "paid" ||
    normalized === "succeeded" ||
    normalized === "complete"
  ) {
    return "success";
  }
  if (
    normalized === "open" ||
    normalized === "pending" ||
    normalized === "draft"
  ) {
    return "warning";
  }
  return "danger";
}

function formatUsdLimit(value: number): string {
  return value.toLocaleString("en-US");
}

export function BillingTab({ user }: BillingTabProps) {
  const t = useCloudT();
  const navigate = useNavigate();
  const amountInputRef = useRef<HTMLInputElement>(null);
  const fieldId = useId();
  const amountInputId = `${fieldId}-purchase-amount`;
  const amountHintId = `${fieldId}-purchase-amount-hint`;
  const amountErrorId = `${fieldId}-purchase-amount-error`;
  const amountConfirmId = `${fieldId}-purchase-amount-confirm`;
  const [invoices, setInvoices] = useState<InvoiceDisplay[]>([]);
  const [loadingInvoices, setLoadingInvoices] = useState(true);
  const [invoicesError, setInvoicesError] = useState<string | null>(null);
  const [purchaseAmount, setPurchaseAmount] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
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
      // error-policy:J4 user-facing degrade — keep the seeded balance
      // on a transient refresh failure.
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
      // error-policy:J4 user-facing degrade — invoice history is optional
      // to buying credits; show an explicit load failure in the list.
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
      // error-policy:J4 user-facing degrade — crypto is optional; absence
      // just hides the crypto payment path.
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void fetchInvoices();
      void fetchBalance(true);
      void fetchCryptoStatus();
    });
  }, [fetchInvoices, fetchBalance, fetchCryptoStatus]);

  const parsedAmountValue = Number.parseFloat(purchaseAmount);
  const amountValue = Number.isNaN(parsedAmountValue)
    ? null
    : parsedAmountValue;
  const isValidAmount =
    amountValue !== null &&
    amountValue >= AMOUNT_LIMITS.MIN &&
    amountValue <= AMOUNT_LIMITS.MAX;

  const resolveAmountError = useCallback(
    (rawAmount: string): string | null => {
      const parsed = Number.parseFloat(rawAmount);
      if (rawAmount.trim() === "" || Number.isNaN(parsed)) {
        return t("cloud.billingTab.enterAmountRange", {
          min: formatUsdLimit(AMOUNT_LIMITS.MIN),
          max: formatUsdLimit(AMOUNT_LIMITS.MAX),
          defaultValue:
            "Enter an amount between $" + "{{min}} and $" + "{{max}}",
        });
      }
      if (parsed < AMOUNT_LIMITS.MIN) {
        return t("cloud.billingTab.minAmount", {
          min: formatUsdLimit(AMOUNT_LIMITS.MIN),
          defaultValue: "Enter at least $" + "{{min}}",
        });
      }
      if (parsed > AMOUNT_LIMITS.MAX) {
        return t("cloud.billingTab.maxAmount", {
          max: formatUsdLimit(AMOUNT_LIMITS.MAX),
          defaultValue: "Enter $" + "{{max}} or less",
        });
      }
      return null;
    },
    [t],
  );

  const liveAmountError =
    purchaseAmount.trim() !== "" && !isValidAmount
      ? resolveAmountError(purchaseAmount)
      : null;
  const shownAmountError = liveAmountError ?? amountError;
  const amountDescribedBy = [
    amountHintId,
    shownAmountError ? amountErrorId : null,
    isValidAmount ? amountConfirmId : null,
  ]
    .filter(Boolean)
    .join(" ");

  const handleBuyCredits = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const nextError = resolveAmountError(purchaseAmount);
    if (nextError) {
      setAmountError(nextError);
      amountInputRef.current?.focus();
      return;
    }

    const amount = parseFloat(purchaseAmount);
    setAmountError(null);
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
        // error-policy:J1 boundary translation — checkout stays on the form
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
      // error-policy:J1 boundary translation — checkout stays on the form
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
    navigate(`/cloud/invoices/${invoice.id}`);
  };

  const buyButtonLabel =
    paymentMethod === "crypto"
      ? t("cloud.billingTab.payWithCrypto", {
          defaultValue: "Pay with crypto",
        })
      : t("cloud.billingTab.buyCredits", {
          defaultValue: "Buy credits",
        });

  return (
    <div className="flex flex-col gap-4 md:gap-6 pb-6 md:pb-8">
      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-muted" />
            <h3 className="text-balance text-base font-mono text-txt uppercase">
              {t("cloud.billingTab.creditBalance", {
                defaultValue: "Credit Balance",
              })}
            </h3>
          </div>

          <div className="flex flex-col lg:flex-row gap-6 w-full min-w-0">
            <div className="w-full min-w-0 lg:w-[400px] flex">
              <div className="bg-surface border border-brand-surface flex-1 flex items-center justify-center py-6 lg:py-8 min-w-0">
                <div className="flex flex-col items-center justify-center gap-1 px-4 min-w-0">
                  <p className="break-all text-[40px] font-mono text-txt-strong tracking-tight tabular-nums">
                    ${balance.toFixed(2)}
                  </p>
                  <p className="text-pretty text-sm text-muted-strong text-center">
                    {t("cloud.billingTab.remainingBalance", {
                      defaultValue: "Remaining balance",
                    })}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex-1 flex flex-col gap-6 lg:justify-center min-w-0">
              <form
                className="flex flex-col gap-4 min-w-0"
                onSubmit={(event) => {
                  void handleBuyCredits(event);
                }}
                noValidate
              >
                <p className="text-balance text-base font-mono text-txt">
                  {t("cloud.billingTab.addCredits", {
                    defaultValue: "Add credits to your account",
                  })}
                </p>
                <p
                  id={amountHintId}
                  className="text-pretty text-sm text-muted-strong"
                >
                  {t("cloud.billingTab.amountHint", {
                    min: formatUsdLimit(AMOUNT_LIMITS.MIN),
                    max: formatUsdLimit(AMOUNT_LIMITS.MAX),
                    defaultValue:
                      "Enter an amount between $" +
                      "{{min}}" +
                      " and $" +
                      "{{max}}.",
                  })}
                </p>

                {cryptoStatus?.enabled && (
                  <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
                    <legend className="sr-only">
                      {t("cloud.billingTab.paymentMethod", {
                        defaultValue: "Payment method",
                      })}
                    </legend>
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => setPaymentMethod("card")}
                      aria-pressed={paymentMethod === "card"}
                      className={`flex min-h-11 items-center gap-2 px-4 py-2 font-mono text-sm border transition-colors ${
                        paymentMethod === "card"
                          ? "bg-txt border-txt text-bg"
                          : "bg-transparent border-border text-muted-strong hover:border-border-strong"
                      }`}
                    >
                      <CreditCard className="h-4 w-4" aria-hidden="true" />
                      {t("cloud.billingTab.card", { defaultValue: "Card" })}
                    </Button>
                    <Button
                      variant="ghost"
                      type="button"
                      onClick={() => setPaymentMethod("crypto")}
                      aria-pressed={paymentMethod === "crypto"}
                      className={`flex min-h-11 items-center gap-2 px-4 py-2 font-mono text-sm border transition-colors ${
                        paymentMethod === "crypto"
                          ? "bg-txt border-txt text-bg"
                          : "bg-transparent border-border text-muted-strong hover:border-border-strong"
                      }`}
                    >
                      <Wallet className="h-4 w-4" aria-hidden="true" />
                      {t("cloud.billingTab.crypto", { defaultValue: "Crypto" })}
                    </Button>
                  </fieldset>
                )}

                <div className="flex flex-col sm:flex-row items-stretch sm:items-end gap-4 min-w-0">
                  <div className="flex-1 min-w-0 max-w-xs">
                    <Label
                      htmlFor={amountInputId}
                      className="mb-1.5 block text-muted-strong font-mono text-xs"
                    >
                      {t("cloud.billingTab.amountLabel", {
                        defaultValue: "Amount (USD)",
                      })}
                    </Label>
                    <div className="relative">
                      <span
                        className="absolute left-3 top-1/2 -translate-y-1/2 text-txt font-mono tabular-nums z-10 pointer-events-none"
                        aria-hidden="true"
                      >
                        $
                      </span>
                      <Input
                        ref={amountInputRef}
                        id={amountInputId}
                        name="purchaseAmount"
                        type="number"
                        inputMode="decimal"
                        autoComplete="transaction-amount"
                        step="1"
                        min={AMOUNT_LIMITS.MIN}
                        max={AMOUNT_LIMITS.MAX}
                        value={purchaseAmount}
                        onChange={(e) => {
                          setPurchaseAmount(e.target.value);
                          if (amountError) {
                            setAmountError(resolveAmountError(e.target.value));
                          }
                        }}
                        aria-invalid={shownAmountError ? true : undefined}
                        aria-describedby={amountDescribedBy}
                        hasError={Boolean(shownAmountError)}
                        className="pl-7 bg-surface border border-border text-txt h-11 font-mono tabular-nums text-base sm:text-sm"
                        placeholder="25.00"
                        disabled={isProcessingCheckout}
                      />
                    </div>
                  </div>

                  {(paymentMethod !== "crypto" ||
                    !cryptoStatus?.directWallet?.enabled) && (
                    <BrandButton
                      type="submit"
                      variant="primary"
                      disabled={isProcessingCheckout}
                      aria-busy={isProcessingCheckout}
                      className="h-11 px-6 w-full sm:w-auto flex-shrink-0 font-mono text-base whitespace-normal sm:whitespace-nowrap disabled:border disabled:border-border disabled:bg-surface disabled:text-muted-strong disabled:opacity-100"
                    >
                      {isProcessingCheckout ? (
                        <Loader2
                          className="h-4 w-4 animate-spin"
                          aria-hidden="true"
                        />
                      ) : null}
                      {buyButtonLabel}
                    </BrandButton>
                  )}
                </div>

                {shownAmountError ? (
                  <div
                    id={amountErrorId}
                    role="alert"
                    className="flex items-start gap-2 text-sm text-destructive"
                  >
                    <AlertCircle
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="font-mono text-pretty">
                      {shownAmountError}
                    </span>
                  </div>
                ) : null}

                {isValidAmount && purchaseAmount && amountValue !== null ? (
                  <div
                    id={amountConfirmId}
                    className="flex items-start gap-2 text-sm text-status-success"
                  >
                    <CheckCircle
                      className="mt-0.5 h-4 w-4 shrink-0"
                      aria-hidden="true"
                    />
                    <span className="font-mono text-pretty tabular-nums">
                      {t("cloud.billingTab.willBeAdded", {
                        amount: amountValue.toFixed(2),
                        defaultValue:
                          "$" + "{{amount}}" + " will be added to your balance",
                      })}
                    </span>
                  </div>
                ) : null}

                {paymentMethod === "crypto" &&
                cryptoStatus?.directWallet?.enabled ? (
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
                ) : null}
              </form>
            </div>
          </div>
        </div>
      </BrandCard>

      <PayAsYouGoCard />

      <AutoTopUpCard />

      <BrandCard className="relative">
        <CornerBrackets size="sm" className="opacity-50" />

        <div className="relative z-10 space-y-6 min-w-0">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-muted" />
              <h3 className="text-balance text-base font-mono text-txt uppercase">
                {t("cloud.billingTab.invoices", { defaultValue: "Invoices" })}
              </h3>
            </div>
            <p className="text-pretty text-xs font-mono text-muted-strong tracking-tight">
              {t("cloud.billingTab.invoicesDesc", {
                defaultValue:
                  "View your payment history and download invoices.",
              })}
            </p>
          </div>

          <div className="w-full min-w-0">
            <div className="hidden sm:flex w-full min-w-0">
              <div className="bg-surface border border-brand-surface min-w-0 flex-[1.5] p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colDateTime", {
                    defaultValue: "Date & Time",
                  })}
                </p>
              </div>
              <div className="bg-surface border-t border-r border-b border-brand-surface min-w-0 flex-1 p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colTotal", { defaultValue: "Total" })}
                </p>
              </div>
              <div className="bg-surface border-t border-r border-b border-brand-surface min-w-0 flex-1 p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colStatus", {
                    defaultValue: "Status",
                  })}
                </p>
              </div>
              <div className="bg-surface border-t border-r border-b border-brand-surface min-w-0 flex-1 p-3 md:p-4">
                <p className="text-xs md:text-sm font-mono font-bold text-txt-strong uppercase">
                  {t("cloud.billingTab.colActions", {
                    defaultValue: "Actions",
                  })}
                </p>
              </div>
            </div>

            {loadingInvoices ? (
              <div
                role="status"
                aria-live="polite"
                className="flex items-center justify-center gap-2 p-8 border border-t-0 sm:border-t-0 border-brand-surface border-l border-r border-b"
              >
                <Loader2
                  className="h-6 w-6 animate-spin text-muted-strong"
                  aria-hidden="true"
                />
                <span className="sr-only">
                  {t("cloud.billingTab.loadingInvoices", {
                    defaultValue: "Loading invoices",
                  })}
                </span>
              </div>
            ) : invoicesError ? (
              <div
                role="alert"
                className="flex items-start gap-3 p-8 border-l border-r border-b border-brand-surface bg-destructive/5"
              >
                <AlertCircle
                  className="mt-0.5 h-4 w-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <div className="space-y-1 min-w-0">
                  <p className="text-pretty text-xs md:text-sm text-destructive font-mono">
                    {t("cloud.billingTab.invoiceLoadFailed", {
                      defaultValue: "Invoice history could not be loaded",
                    })}
                  </p>
                  <p className="text-pretty text-xs text-muted-strong font-mono break-words">
                    {invoicesError}
                  </p>
                </div>
              </div>
            ) : invoices.length === 0 ? (
              <div className="flex flex-col items-start justify-center gap-1 p-8 border-l border-r border-b border-brand-surface">
                <p className="text-pretty text-xs md:text-sm text-txt font-mono">
                  {t("cloud.billingTab.noInvoices", {
                    defaultValue: "No invoices yet",
                  })}
                </p>
                <p className="text-pretty text-xs text-muted-strong font-mono">
                  {t("cloud.billingTab.noInvoicesHint", {
                    defaultValue:
                      "Buy credits above to generate your first invoice.",
                  })}
                </p>
              </div>
            ) : (
              invoices.map((invoice) => {
                const tone = invoiceStatusTone(invoice.status);
                const StatusIcon =
                  tone === "success"
                    ? CheckCircle
                    : tone === "warning"
                      ? AlertCircle
                      : XCircle;
                const statusClass =
                  tone === "success"
                    ? "text-status-success"
                    : tone === "warning"
                      ? "text-status-warning"
                      : "text-destructive";
                return (
                  <div
                    key={invoice.id}
                    className="flex w-full min-w-0 flex-col sm:flex-row"
                  >
                    <div className="bg-surface border-l border-r border-b border-brand-surface min-w-0 sm:flex-[1.5] p-3 md:p-4">
                      <p className="sm:hidden mb-1 text-xs font-mono font-bold text-muted-strong uppercase">
                        {t("cloud.billingTab.colDateTime", {
                          defaultValue: "Date & Time",
                        })}
                      </p>
                      <p className="break-words text-xs md:text-sm font-mono text-txt-strong">
                        {invoice.date}
                      </p>
                    </div>
                    <div className="bg-surface border-l sm:border-l-0 border-r border-b border-brand-surface min-w-0 sm:flex-1 p-3 md:p-4">
                      <p className="sm:hidden mb-1 text-xs font-mono font-bold text-muted-strong uppercase">
                        {t("cloud.billingTab.colTotal", {
                          defaultValue: "Total",
                        })}
                      </p>
                      <p className="break-words text-xs md:text-sm font-mono text-txt-strong tabular-nums">
                        {invoice.total}
                      </p>
                    </div>
                    <div className="bg-surface border-l sm:border-l-0 border-r border-b border-brand-surface min-w-0 sm:flex-1 p-3 md:p-4">
                      <p className="sm:hidden mb-1 text-xs font-mono font-bold text-muted-strong uppercase">
                        {t("cloud.billingTab.colStatus", {
                          defaultValue: "Status",
                        })}
                      </p>
                      <p
                        className={`flex items-center gap-1.5 break-words text-xs md:text-sm font-mono uppercase ${statusClass}`}
                      >
                        <StatusIcon
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden="true"
                        />
                        <span>{invoice.status}</span>
                      </p>
                    </div>
                    <div className="bg-surface border-l sm:border-l-0 border-r border-b border-brand-surface min-w-0 sm:flex-1 p-3 md:p-4">
                      <p className="sm:hidden mb-1 text-xs font-mono font-bold text-muted-strong uppercase">
                        {t("cloud.billingTab.colActions", {
                          defaultValue: "Actions",
                        })}
                      </p>
                      <Button
                        variant="ghost"
                        type="button"
                        onClick={() => handleViewInvoice(invoice)}
                        aria-label={t("cloud.billingTab.viewInvoiceNamed", {
                          date: invoice.date,
                          defaultValue: "View invoice from {{date}}",
                        })}
                        className="min-h-11 px-0 text-xs md:text-sm font-mono text-txt-strong underline hover:text-txt transition-colors"
                      >
                        {t("cloud.billingTab.viewInvoice", {
                          defaultValue: "View invoice",
                        })}
                      </Button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </BrandCard>
    </div>
  );
}

export type { BillingUser };
