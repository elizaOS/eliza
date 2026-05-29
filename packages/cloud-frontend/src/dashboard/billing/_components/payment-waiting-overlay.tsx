"use client";

/**
 * PaymentWaitingOverlay — holds the user on a "Confirming on-chain" screen
 * until a direct-crypto payment resolves to confirmed or failed_chain.
 *
 * Poll cadence: every 3s. Cancels on confirmed/failed_chain/failed/expired.
 *
 * Recovery: the parent persists `{paymentId, txHash, network}` to
 * localStorage immediately after broadcast, so a refresh re-enters this
 * overlay against the same paymentId and resumes polling — no orphaned
 * payments due to closed tabs.
 */

import { Button } from "@elizaos/ui";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { useEffect } from "react";

import { useT } from "@/providers/I18nProvider";
import { api } from "../../../lib/api-client";

export interface PaymentWaitingStatus {
  paymentId: string;
  status: string;
  network: "base" | "bsc" | "solana" | null;
  txHash: string | null;
  blockNumber: string | null;
  expectedAmount: string;
  creditsToAdd: string;
  bonusCredits: number;
  expiresAt: string;
  confirmedAt: string | null;
  explorerUrl: string | null;
  error: string | null;
}

interface ApiResponse {
  success: boolean;
  data: PaymentWaitingStatus;
}

interface PaymentWaitingOverlayProps {
  paymentId: string;
  /** Called once the payment terminally resolves. */
  onResolved: (status: PaymentWaitingStatus) => void;
  /** User dismisses the overlay manually (e.g. "Hide and keep watching"). */
  onDismiss: () => void;
}

function isTerminal(status: string): boolean {
  return (
    status === "confirmed" ||
    status === "failed" ||
    status === "failed_chain" ||
    status === "expired"
  );
}

export function PaymentWaitingOverlay({
  paymentId,
  onResolved,
  onDismiss,
}: PaymentWaitingOverlayProps) {
  const t = useT();
  const { data, error, isLoading } = useQuery({
    queryKey: ["direct-crypto-payment", paymentId],
    queryFn: async () => {
      const res = await api<ApiResponse>(
        `/api/crypto/direct-payments/${encodeURIComponent(paymentId)}`,
      );
      return res.data;
    },
    refetchInterval: (q) => {
      const s = q.state.data?.status;
      return s && isTerminal(s) ? false : 3000;
    },
    refetchIntervalInBackground: true,
    staleTime: 0,
  });

  useEffect(() => {
    if (data && isTerminal(data.status)) {
      onResolved(data);
    }
  }, [data, onResolved]);

  const status = data?.status ?? (isLoading ? "loading" : "unknown");
  const isFailed =
    status === "failed" || status === "failed_chain" || status === "expired";
  const isConfirmed = status === "confirmed";
  const isWaiting = !isFailed && !isConfirmed;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
    >
      <div className="w-full max-w-md border border-white/10 bg-[#0b0d11] p-6 text-white shadow-2xl">
        <div className="flex flex-col items-center text-center">
          {isConfirmed ? (
            <CheckCircle2 className="h-12 w-12 text-emerald-300" />
          ) : isFailed ? (
            <XCircle className="h-12 w-12 text-red-300" />
          ) : (
            <Loader2 className="h-12 w-12 animate-spin text-white/80" />
          )}

          <h2 className="mt-5 text-xl font-semibold">
            {isConfirmed
              ? t("cloud.paymentWaiting.creditAdded", {
                  defaultValue: "Credit added",
                })
              : isFailed
                ? t("cloud.paymentWaiting.paymentFailed", {
                    defaultValue: "Payment failed",
                  })
                : t("cloud.paymentWaiting.confirmingOnChain", {
                    defaultValue: "Confirming on-chain",
                  })}
          </h2>

          <p className="mt-2 text-sm text-white/65">
            {isConfirmed
              ? data?.bonusCredits
                ? t("cloud.paymentWaiting.addedCreditWithBonus", {
                    amount: data?.creditsToAdd ?? "—",
                    bonus: data.bonusCredits,
                    defaultValue:
                      "Added ${{amount}} in cloud credit (incl. ${{bonus}} bonus).",
                  })
                : t("cloud.paymentWaiting.addedCredit", {
                    amount: data?.creditsToAdd ?? "—",
                    defaultValue: "Added ${{amount}} in cloud credit.",
                  })
              : isFailed
                ? (data?.error ??
                  t("cloud.paymentWaiting.couldNotConfirm", {
                    defaultValue:
                      "We could not confirm this transaction on chain. Contact support with the tx hash below.",
                  }))
                : t("cloud.paymentWaiting.waitingForNetwork", {
                    defaultValue:
                      "Waiting for the network. This usually takes 10–30 seconds. Don't close this tab — we'll resume if you do.",
                  })}
          </p>

          {data?.txHash && (
            <div className="mt-4 w-full">
              <div className="text-xs text-white/45">
                {t("cloud.paymentWaiting.transaction", {
                  defaultValue: "Transaction",
                })}
              </div>
              <div className="mt-1 break-all rounded-xs border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-xs text-white/85">
                {data.txHash}
              </div>
              {data.explorerUrl && (
                <a
                  href={data.explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 text-xs text-white/70 hover:text-white"
                >
                  {t("cloud.paymentWaiting.viewOnExplorer", {
                    defaultValue: "View on explorer",
                  })}
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
            </div>
          )}

          {error && !data && (
            <p className="mt-4 text-sm text-red-200">
              {error instanceof Error
                ? error.message
                : t("cloud.paymentWaiting.statusLookupFailed", {
                    defaultValue: "Status lookup failed.",
                  })}
            </p>
          )}

          <div className="mt-6 flex gap-3">
            {isConfirmed ? (
              <Button onClick={onDismiss} className="rounded-xs">
                {t("cloud.paymentWaiting.done", { defaultValue: "Done" })}
              </Button>
            ) : isFailed ? (
              <Button
                onClick={onDismiss}
                variant="surface"
                className="rounded-xs"
              >
                {t("cloud.paymentWaiting.close", { defaultValue: "Close" })}
              </Button>
            ) : (
              <Button
                onClick={onDismiss}
                variant="surface"
                className="rounded-xs text-white/80"
              >
                {t("cloud.paymentWaiting.hideKeepWatching", {
                  defaultValue: "Hide — keep watching in background",
                })}
              </Button>
            )}
          </div>

          {isWaiting && data?.expiresAt && (
            <p className="mt-4 text-xs text-white/40">
              {t("cloud.paymentWaiting.expires", {
                time: new Date(data.expiresAt).toLocaleTimeString(),
                defaultValue: "expires {{time}}",
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const STORAGE_KEY = "milady.pendingDirectCryptoPayment.v1";

export interface PersistedPendingPayment {
  paymentId: string;
  txHash: string | null;
  network: "base" | "bsc" | "solana";
  createdAt: number;
}

/** Best-effort localStorage helpers. SSR-safe; never throw. */
export const pendingPaymentStore = {
  load(): PersistedPendingPayment | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as PersistedPendingPayment;
      // Drop entries older than 1h — past expiry on the server side.
      if (Date.now() - parsed.createdAt > 60 * 60 * 1000) {
        window.localStorage.removeItem(STORAGE_KEY);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  },
  save(value: PersistedPendingPayment): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // quota / private mode — non-fatal
    }
  },
  clear(): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // non-fatal
    }
  },
};
