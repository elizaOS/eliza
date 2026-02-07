"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2, Copy, CheckCircle, AlertCircle, Wallet } from "lucide-react";
import { toast } from "sonner";
import Image from "next/image";
import { useWallets, usePrivy } from "@privy-io/react-auth";
import { trackEvent } from "@/lib/analytics/posthog";

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

interface TokenConfig {
  decimals: number;
  contracts: Record<number, string>;
}

const TOKEN_CONFIG: Record<string, TokenConfig> = {
  USDT: {
    decimals: 6,
    contracts: {
      1: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      56: "0x55d398326f99059fF775485246999027B3197955",
      137: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      42161: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      10: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    },
  },
  USDC: {
    decimals: 6,
    contracts: {
      1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      56: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
      137: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      42161: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    },
  },
  ETH: { decimals: 18, contracts: {} },
  BNB: { decimals: 18, contracts: {} },
  MATIC: { decimals: 18, contracts: {} },
  AVAX: { decimals: 18, contracts: {} },
};

const NATIVE_TOKENS = ["ETH", "BNB", "MATIC", "AVAX"];

function getTokenDecimals(token: string): number {
  const tokenConfig = TOKEN_CONFIG[token.toUpperCase()];
  return tokenConfig?.decimals || 18;
}

function encodeTransferData(to: string, amount: bigint): string {
  const functionSelector = "0xa9059cbb";
  const paddedTo = to.toLowerCase().replace("0x", "").padStart(64, "0");
  const paddedAmount = amount.toString(16).padStart(64, "0");
  return `${functionSelector}${paddedTo}${paddedAmount}`;
}

function parseTokenAmount(amount: string, decimals = 18): bigint {
  const [whole, fraction = ""] = amount.split(".");

  if (fraction.length > decimals) {
    console.warn(
      `[Crypto Payment] Precision loss: ${amount} truncated to ${decimals} decimals`,
    );
  }

  const paddedFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole + paddedFraction);
}

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

function isNativeToken(currency: string): boolean {
  return NATIVE_TOKENS.includes(currency.toUpperCase());
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
  const { wallets, ready: walletsReady } = useWallets();
  const { connectWallet, ready: privyReady } = usePrivy();
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [isPolling, setIsPolling] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<number>(0);
  const [isSendingTx, setIsSendingTx] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const networkInfo = getNetworkInfo(network);
  const isEvmNetwork = networkInfo !== null && networkInfo.chainId > 0;

  const evmWallet =
    wallets.find((w) => {
      if (w.walletClientType === "solana") return false;
      if (w.walletClientType === "privy") return false;
      return true;
    }) ||
    wallets.find(
      (w) => w.walletClientType !== "solana" && w.walletClientType !== "privy",
    );

  const hasWallet = walletsReady && !!evmWallet;

  // Track in-flight request to prevent concurrent polling
  const isCheckingRef = useRef(false);
  // AbortController for cancelling in-flight requests on unmount or refresh
  const abortControllerRef = useRef<AbortController | null>(null);

  const checkPaymentStatus = useCallback(async () => {
    // Prevent concurrent requests - if a check is already in progress, skip this one
    if (isCheckingRef.current) {
      console.log(
        "[Crypto Payment] Skipping status check - request already in progress",
      );
      return;
    }

    // Cancel any previous in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    // Create new AbortController for this request
    abortControllerRef.current = new AbortController();
    isCheckingRef.current = true;

    try {
      const response = await fetch(`/api/crypto/payments/${paymentId}`, {
        signal: abortControllerRef.current.signal,
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
      } else {
        console.error("[Crypto Payment] Status check failed:", response.status);
      }
    } catch (error) {
      // Ignore abort errors - they're expected when component unmounts or we cancel
      if (error instanceof Error && error.name === "AbortError") {
        console.log("[Crypto Payment] Status check aborted");
        return;
      }
      console.error("[Crypto Payment] Status check error:", error);
    } finally {
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
      const delay =
        intervals[Math.min(currentIntervalIndex, intervals.length - 1)];
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
    setCopied(label);
    toast.success(`${label} copied`);
    setTimeout(() => setCopied(null), 2000);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const getNetworkDisplayName = (): string => {
    return networkInfo?.name || network;
  };

  const handleConnectWallet = async () => {
    if (!privyReady) return;
    setIsConnecting(true);
    try {
      await connectWallet();
      toast.success("Wallet connected!");

      // Track wallet connected event
      trackEvent("crypto_wallet_connected", {
        wallet_type: "external",
        network: network,
        payment_id: paymentId,
      });
    } catch (error) {
      console.error("Failed to connect wallet:", error);
      toast.error("Failed to connect wallet");
    } finally {
      setIsConnecting(false);
    }
  };

  const handlePayWithWallet = async () => {
    if (!evmWallet || !networkInfo) return;

    setIsSendingTx(true);

    try {
      const provider = await evmWallet.getEthereumProvider();

      const currentChainId = await provider.request({ method: "eth_chainId" });
      const targetChainId = `0x${networkInfo.chainId.toString(16)}`;

      if (currentChainId !== targetChainId) {
        try {
          await provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: targetChainId }],
          });
        } catch (switchError: unknown) {
          const code = (switchError as { code?: number })?.code;
          if (code === 4902) {
            toast.error(
              `Please add ${networkInfo.name} network to your wallet`,
            );
          } else {
            toast.error(`Please switch to ${networkInfo.name} network`);
          }
          setIsSendingTx(false);
          return;
        }
      }

      const accounts = (await provider.request({
        method: "eth_accounts",
      })) as string[];
      if (!accounts || accounts.length === 0) {
        toast.error("No wallet account found");
        setIsSendingTx(false);
        return;
      }

      let txHashResult: string;

      if (isNativeToken(payCurrency)) {
        const decimals = getTokenDecimals(payCurrency);
        const amountWei = parseTokenAmount(payAmount, decimals);
        txHashResult = (await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: accounts[0],
              to: paymentAddress,
              value: `0x${amountWei.toString(16)}`,
            },
          ],
        })) as string;
      } else {
        const tokenConfig = TOKEN_CONFIG[payCurrency.toUpperCase()];
        const tokenContract = tokenConfig?.contracts[networkInfo.chainId];

        if (!tokenContract) {
          toast.error(`${payCurrency} not supported on ${networkInfo.name}`);
          setIsSendingTx(false);
          return;
        }

        const decimals = tokenConfig.decimals;
        const amount = parseTokenAmount(payAmount, decimals);
        const data = encodeTransferData(paymentAddress, amount);

        txHashResult = (await provider.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: accounts[0],
              to: tokenContract,
              data,
            },
          ],
        })) as string;
      }

      setTxHash(txHashResult);
      toast.success("Transaction sent! Waiting for confirmation...");

      // Track payment sent event
      trackEvent("crypto_payment_sent", {
        payment_id: paymentId,
        track_id: trackId,
        tx_hash: txHashResult,
        network: network,
        token: payCurrency,
        amount: payAmount,
      });

      setTimeout(() => {
        checkPaymentStatus();
      }, 5000);
    } catch (error: unknown) {
      console.error("Wallet payment error:", error);
      const errorMessage =
        (error as { message?: string })?.message || "Transaction failed";
      if (
        errorMessage.includes("rejected") ||
        errorMessage.includes("denied")
      ) {
        toast.error("Transaction rejected");
      } else {
        toast.error(errorMessage.slice(0, 100));
      }
    } finally {
      setIsSendingTx(false);
    }
  };

  const isExpired = timeLeft === 0;

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
            <h3 className="text-base font-mono text-[#e1e1e1] uppercase">
              {payCurrency} Payment
            </h3>
          </div>

          {isExpired ? (
            <div className="text-center py-8">
              <AlertCircle className="h-12 w-12 text-red-400 mx-auto mb-4" />
              <p className="text-white font-mono">Payment Expired</p>
              <p className="text-white/60 text-sm mt-2">
                Please create a new payment request
              </p>
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
              <p className="text-white/60 text-sm mt-2">
                Please create a new payment request
              </p>
            </div>
          ) : (
            <>
              <div className="text-center">
                <p className="text-3xl font-mono text-white">
                  {payAmount}{" "}
                  <span className="text-sm text-white/60">{payCurrency}</span>
                </p>
                <p className="text-sm text-white/60 mt-1">
                  on {getNetworkDisplayName()}
                </p>
                <p className="text-xs text-white/40 mt-1">
                  ≈ ${creditsToAdd} USD
                </p>
              </div>

              {isEvmNetwork && hasWallet && (
                <button
                  type="button"
                  onClick={handlePayWithWallet}
                  disabled={isSendingTx}
                  className="w-full bg-[#FF5800] hover:bg-[#FF5800]/80 disabled:opacity-50 px-4 py-3 text-white font-mono text-sm flex items-center justify-center gap-2 transition-colors"
                >
                  {isSendingTx ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Confirm in Wallet...
                    </>
                  ) : (
                    <>
                      <Wallet className="h-4 w-4" />
                      Pay with Wallet
                    </>
                  )}
                </button>
              )}

              {isEvmNetwork && !hasWallet && (
                <button
                  type="button"
                  onClick={handleConnectWallet}
                  disabled={isConnecting || !privyReady}
                  className="w-full bg-[#FF5800] hover:bg-[#FF5800]/80 disabled:opacity-50 px-4 py-3 text-white font-mono text-sm flex items-center justify-center gap-2 transition-colors"
                >
                  {isConnecting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Connecting...
                    </>
                  ) : (
                    <>
                      <Wallet className="h-4 w-4" />
                      Connect Wallet to Pay
                    </>
                  )}
                </button>
              )}

              {txHash && (
                <div className="bg-green-900/20 border border-green-500/30 p-3 rounded">
                  <p className="text-xs text-green-400 font-mono">
                    Transaction sent! Hash: {txHash.slice(0, 10)}...
                    {txHash.slice(-8)}
                  </p>
                </div>
              )}

              {isEvmNetwork && (
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-px bg-white/10" />
                  <span className="text-xs text-white/40 font-mono">
                    OR PAY MANUALLY
                  </span>
                  <div className="flex-1 h-px bg-white/10" />
                </div>
              )}

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
                  <span className="text-white/60 font-mono">
                    Time remaining
                  </span>
                  <span
                    className={`font-mono ${timeLeft < 300 ? "text-red-400" : "text-white"}`}
                  >
                    {formatTime(timeLeft)}
                  </span>
                </div>

                <div className="flex items-center justify-center gap-2 text-white/60">
                  {isPolling && <Loader2 className="h-4 w-4 animate-spin" />}
                  <span className="text-xs font-mono">
                    Waiting for payment...
                  </span>
                </div>

                <div className="text-xs text-white/40 text-center">
                  Track ID: {trackId}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
