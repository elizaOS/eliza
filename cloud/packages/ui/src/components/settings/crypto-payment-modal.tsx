"use client";

import Image from "@elizaos/cloud-ui/runtime/image";
import { AlertCircle, CheckCircle, Copy, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface CryptoPaymentModalProps {
  paymentId: string;
  trackId: string;
  paymentAddress: string;
  payAmount: string;
  payCurrency: string;
  network: string;
  qrCode?: string;
  creditsToAdd: string;
  expiresAt: string;
  onClose: () => void;
  onSuccess: () => void;
}

interface PaymentStatus {
  status: string;
  confirmed: boolean;
  receivedAmount?: string;
  transactionHash?: string;
}

interface NetworkInfo {
  chainId: number;
  name: string;
  nativeCurrency: string;
  aliases: string[];
}

const NETWORK_CONFIG: Record<string, NetworkInfo> = {
  ERC20: {
    chainId: 1,
    name: "Ethereum",
    nativeCurrency: "ETH",
    aliases: ["ERC20", "ETH", "Ethereum", "Ethereum Network"],
  },
  BEP20: {
    chainId: 56,
    name: "BNB Smart Chain",
    nativeCurrency: "BNB",
    aliases: ["BEP20", "BSC", "BNB Smart Chain", "Binance Smart Chain"],
  },
  POLYGON: {
    chainId: 137,
    name: "Polygon",
    nativeCurrency: "MATIC",
    aliases: ["POLYGON", "Polygon", "Polygon Network", "MATIC"],
  },
  BASE: {
    chainId: 8453,
    name: "Base",
    nativeCurrency: "ETH",
    aliases: ["BASE", "Base", "Base Network"],
  },
  ARB: {
    chainId: 42161,
    name: "Arbitrum",
    nativeCurrency: "ETH",
    aliases: ["ARB", "Arbitrum", "Arbitrum Network", "Arbitrum One"],
  },
  OP: {
    chainId: 10,
    name: "Optimism",
    nativeCurrency: "ETH",
    aliases: ["OP", "Optimism", "Optimism Network"],
  },
  TRC20: {
    chainId: 0,
    name: "Tron",
    nativeCurrency: "TRX",
    aliases: ["TRC20", "Tron", "TRON", "Tron Network"],
  },
  SOL: {
    chainId: 0,
    name: "Solana",
    nativeCurrency: "SOL",
    aliases: ["SOL", "Solana", "Solana Network"],
  },
};

function getNetworkInfo(network: string): NetworkInfo | null {
  const normalized = network.toUpperCase().replace(/[_\s]+/g, "");

  for (const config of Object.values(NETWORK_CONFIG)) {
    const match = config.aliases.some(
      (alias) => alias.toUpperCase().replace(/[_\s]+/g, "") === normalized,
    );
    if (match) {
      return config;
    }
  }

  return null;
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function CryptoPaymentModal({
  paymentId,
  trackId,
  paymentAddress,
  payAmount,
  payCurrency,
  network,
  qrCode,
  creditsToAdd,
  expiresAt,
  onClose,
  onSuccess,
}: CryptoPaymentModalProps) {
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [isPolling, setIsPolling] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);

  const networkInfo = getNetworkInfo(network);

  // Track in-flight request to prevent concurrent polling
  const isCheckingRef = useRef(false);
  // AbortController for cancelling in-flight requests on unmount or refresh
  const abortControllerRef = useRef<AbortController | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkPaymentStatus = useCallback(async () => {
    if (isCheckingRef.current) {
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    isCheckingRef.current = true;

    try {
      const response = await fetch(`/api/crypto/payments/${paymentId}`, {
        signal: controller.signal,
      });
      if (response.ok) {
        const data = await response.json();
        setStatus(data);
        if (data.confirmed || data.status === "confirmed") {
          setIsPolling(false);
          toast.success("Payment confirmed! Credits added to your account.");
          onSuccess();
        } else if (data.status === "expired") {
          setIsPolling(false);
          toast.error("Payment expired");
        } else if (data.status === "failed") {
          setIsPolling(false);
          toast.error("Payment failed");
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        return;
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      isCheckingRef.current = false;
    }
  }, [paymentId, onSuccess]);

  useEffect(() => {
    if (!isPolling) return;

    checkPaymentStatus();

    const intervals = [5000, 10000, 15000, 30000, 60000];
    let currentIntervalIndex = 0;
    let timeoutId: NodeJS.Timeout;

    const scheduleNext = () => {
      const delay = intervals[Math.min(currentIntervalIndex, intervals.length - 1)];
      currentIntervalIndex++;

      timeoutId = setTimeout(() => {
        checkPaymentStatus();
        scheduleNext();
      }, delay);
    };

    scheduleNext();

    return () => {
      // Clear the timeout
      clearTimeout(timeoutId);
      // Abort any in-flight request when component unmounts or polling stops
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      // Reset the checking flag
      isCheckingRef.current = false;
    };
  }, [checkPaymentStatus, isPolling]);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const expires = new Date(expiresAt).getTime();
    const updateTimer = () => {
      const now = Date.now();
      const remaining = Math.max(0, Math.floor((expires - now) / 1000));
      setTimeLeft(remaining);
      if (remaining === 0) {
        setIsPolling(false);
      }
    };
    updateTimer();
    const interval = setInterval(updateTimer, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const copyToClipboard = async (text: string, label: string) => {
    await navigator.clipboard.writeText(text);
    if (copyTimeoutRef.current) {
      clearTimeout(copyTimeoutRef.current);
    }
    setCopied(label);
    toast.success(`${label} copied`);
    copyTimeoutRef.current = setTimeout(() => setCopied(null), 2000);
  };

  const isExpired = timeLeft === 0;
  const networkDisplayName = networkInfo?.name || network;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-md backdrop-blur-sm bg-[rgba(10,10,10,0.95)] border border-brand-surface p-6 relative max-h-[90vh] overflow-y-auto">
        <button
          type="button"
          onClick={onClose}
          className="absolute top-4 right-4 text-white/60 hover:text-white"
        >
          ✕
        </button>

        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-[#FF5800]" />
            <h3 className="text-base font-mono text-[#e1e1e1] uppercase">{payCurrency} Payment</h3>
          </div>

          {isExpired ? (
            <div className="text-center py-8">
              <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
              <p className="text-white font-mono">Payment Expired</p>
              <p className="text-white/60 text-sm mt-2">Please create a new payment request</p>
            </div>
          ) : status?.confirmed || status?.status === "confirmed" ? (
            <div className="text-center py-8">
              <CheckCircle className="h-12 w-12 text-green-400 mx-auto mb-4" />
              <p className="text-white font-mono">Payment Confirmed</p>
              <p className="text-white/60 text-sm mt-2">
                ${creditsToAdd} has been added to your balance
              </p>
            </div>
          ) : status?.status === "failed" ? (
            <div className="text-center py-8">
              <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
              <p className="text-white font-mono">Payment Failed</p>
              <p className="text-white/60 text-sm mt-2">Please create a new payment request</p>
            </div>
          ) : (
            <>
              <div className="text-center">
                <p className="text-3xl font-mono text-white">
                  {payAmount} <span className="text-sm text-white/60">{payCurrency}</span>
                </p>
                <p className="text-sm text-white/60 mt-1">on {networkDisplayName}</p>
                <p className="text-xs text-white/40 mt-1">≈ ${creditsToAdd} USD</p>
              </div>

              {qrCode && (
                <div className="flex justify-center">
                  <div className="bg-white p-3 rounded">
                    <Image
                      src={qrCode}
                      alt="Payment QR Code"
                      width={150}
                      height={150}
                      className="w-[150px] h-[150px]"
                    />
                  </div>
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="text-xs font-mono text-white/60 uppercase block mb-2">
                    Send {payCurrency} to this address
                  </label>
                  <div className="flex items-center gap-2 bg-[rgba(29,29,29,0.5)] border border-[rgba(255,255,255,0.1)] p-3">
                    <code className="text-xs text-white font-mono flex-1 break-all">
                      {paymentAddress}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(paymentAddress, "Address")}
                      className="text-white/60 hover:text-white p-1"
                    >
                      {copied === "Address" ? (
                        <CheckCircle className="h-4 w-4 text-green-400" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="text-xs font-mono text-white/60 uppercase block mb-2">
                    Amount to send
                  </label>
                  <div className="flex items-center gap-2 bg-[rgba(29,29,29,0.5)] border border-[rgba(255,255,255,0.1)] p-3">
                    <code className="text-sm text-white font-mono flex-1">
                      {payAmount} {payCurrency}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToClipboard(payAmount, "Amount")}
                      className="text-white/60 hover:text-white p-1"
                    >
                      {copied === "Amount" ? (
                        <CheckCircle className="h-4 w-4 text-green-400" />
                      ) : (
                        <Copy className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between text-sm">
                  <span className="text-white/60 font-mono">Time remaining</span>
                  <span className={`font-mono ${timeLeft < 300 ? "text-red-400" : "text-white"}`}>
                    {formatTime(timeLeft)}
                  </span>
                </div>

                <div className="flex items-center justify-center gap-2 text-white/60">
                  {isPolling && <Loader2 className="h-4 w-4 animate-spin" />}
                  <span className="text-xs font-mono">Waiting for payment...</span>
                </div>

                <div className="text-xs text-white/40 text-center">Track ID: {trackId}</div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
