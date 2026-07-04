"use client";

/**
 * Wallet section of the cloud agent-instance detail: balance and wallet actions,
 * polled while the document is visible.
 */
import { Check, Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button";
import { useIntervalWhenDocumentVisible } from "../../../hooks/useDocumentVisibility";
import { useCopyFeedback } from "../../lib/use-copy-feedback";
import { useT } from "../lib/i18n";

interface WalletAddresses {
  evmAddress?: string;
  solanaAddress?: string;
}

interface TokenBalance {
  symbol: string;
  name?: string;
  balance: string;
  decimals?: number;
  usdValue?: number;
  address?: string;
  chainId?: number;
}

interface ChainBalance {
  chainId: number;
  chainName: string;
  nativeBalance?: string;
  nativeSymbol?: string;
  nativeUsdValue?: number;
  tokens?: TokenBalance[];
}

interface WalletBalances {
  evm?: ChainBalance[];
  solana?: { balance?: string; tokens?: TokenBalance[] };
}

interface StewardStatus {
  configured: boolean;
  connected: boolean;
  agentId?: string;
  version?: string;
}

function formatNative(wei?: string, symbol = "ETH"): string {
  if (!wei || wei === "0") return `0 ${symbol}`;
  try {
    const val = Number(BigInt(wei)) / 1e18;
    if (val === 0) return `0 ${symbol}`;
    if (val < 0.0001) return `<0.0001 ${symbol}`;
    return `${val.toFixed(4)} ${symbol}`;
  } catch {
    return `— ${symbol}`;
  }
}

function formatUsd(val?: number): string {
  if (val == null) return "";
  return `$${val.toFixed(2)}`;
}

function CopyButton({ text }: { text: string }) {
  const t = useT();
  const { copied, markCopied } = useCopyFeedback(1500);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      markCopied();
    } catch {
      /* ignore */
    }
  }, [text, markCopied]);
  return (
    <Button
      variant="ghost"
      type="button"
      onClick={handleCopy}
      title={t("cloud.elizaWallet.copy", { defaultValue: "Copy" })}
      className="ml-1.5 inline-flex h-7 w-7 shrink-0 items-center justify-center text-muted hover:text-txt transition-colors"
    >
      {copied ? (
        <Check className="w-3 h-3 text-status-success" strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy className="w-3 h-3" strokeWidth={2} aria-hidden="true" />
      )}
    </Button>
  );
}

function SectionHeader({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 mb-3">
      <span className="inline-block size-1.5 bg-accent" />
      <p className="font-mono text-xs-tight uppercase tracking-[0.32em] text-muted-strong">
        {label}
      </p>
    </div>
  );
}

interface ElizaWalletSectionProps {
  agentId: string;
}

interface WalletData {
  addresses: WalletAddresses | null;
  balances: WalletBalances | null;
  steward: StewardStatus | null;
}

export function ElizaWalletSection({ agentId }: ElizaWalletSectionProps) {
  const t = useT();
  const [data, setData] = useState<WalletData>({
    addresses: null,
    balances: null,
    steward: null,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const base = `/api/v1/eliza/agents/${agentId}/api/wallet`;

  const fetchData = useCallback(async () => {
    try {
      const [addrRes, balRes, stewardRes] = await Promise.allSettled([
        fetch(`${base}/addresses`).then((r) =>
          r.ok ? r.json() : Promise.reject(r.statusText),
        ),
        fetch(`${base}/balances`).then((r) =>
          r.ok ? r.json() : Promise.reject(r.statusText),
        ),
        fetch(`${base}/steward-status`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);

      if (!mountedRef.current) return;

      setData({
        addresses: addrRes.status === "fulfilled" ? addrRes.value : null,
        balances: balRes.status === "fulfilled" ? balRes.value : null,
        steward: stewardRes.status === "fulfilled" ? stewardRes.value : null,
      });
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(
        err instanceof Error
          ? err.message
          : t("cloud.elizaWallet.loadFailed", {
              defaultValue: "Failed to load wallet data",
            }),
      );
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [base, t]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchData]);
  useIntervalWhenDocumentVisible(fetchData, 30_000);

  if (loading) {
    return (
      <div className="space-y-3 animate-pulse">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 bg-bg-muted border border-border" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-start gap-3 p-4 bg-destructive-subtle border border-destructive/20">
        <span className="w-2 h-2 rounded-full bg-destructive shrink-0 mt-1" />
        <div>
          <p className="font-mono text-xs text-destructive">
            {t("cloud.elizaWallet.loadFailed", {
              defaultValue: "Failed to load wallet data",
            })}
          </p>
          <p className="font-mono text-xs-tight text-destructive/60 mt-0.5">
            {error}
          </p>
        </div>
      </div>
    );
  }

  const hasEvm = Boolean(data.addresses?.evmAddress);
  const hasSolana = Boolean(data.addresses?.solanaAddress);

  if (!hasEvm && !hasSolana) {
    return (
      <div className="p-8 text-center border border-border bg-card">
        <p className="font-mono text-sm text-muted">
          {t("cloud.elizaWallet.noWallets", {
            defaultValue: "No wallets configured for this agent",
          })}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Addresses */}
      <div>
        <SectionHeader
          label={t("cloud.elizaWallet.addresses", {
            defaultValue: "Addresses",
          })}
        />
        <div className="border border-border bg-card divide-y divide-border">
          {hasEvm && (
            <div className="px-4 py-3 grid grid-cols-[80px_1fr] gap-4 items-center">
              <p className="font-mono text-xs-tight uppercase tracking-[0.2em] text-muted">
                EVM
              </p>
              <div className="flex items-center min-w-0">
                <span className="font-mono text-sm text-txt-strong break-all">
                  {data.addresses?.evmAddress}
                </span>
                <CopyButton text={data.addresses?.evmAddress ?? ""} />
              </div>
            </div>
          )}
          {hasSolana && (
            <div className="px-4 py-3 grid grid-cols-[80px_1fr] gap-4 items-center">
              <p className="font-mono text-xs-tight uppercase tracking-[0.2em] text-muted">
                Solana
              </p>
              <div className="flex items-center min-w-0">
                <span className="font-mono text-sm text-txt-strong break-all">
                  {data.addresses?.solanaAddress}
                </span>
                <CopyButton text={data.addresses?.solanaAddress ?? ""} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Steward status */}
      {data.steward && (
        <div>
          <SectionHeader
            label={t("cloud.elizaWallet.steward", { defaultValue: "Steward" })}
          />
          <div className="border border-border bg-card divide-y divide-border">
            <div className="px-4 py-3 grid grid-cols-[80px_1fr] gap-4 items-center">
              <p className="font-mono text-xs-tight uppercase tracking-[0.2em] text-muted">
                {t("cloud.elizaWallet.status", { defaultValue: "Status" })}
              </p>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-block w-2 h-2 rounded-full ${
                    data.steward.connected ? "bg-status-success" : "bg-muted"
                  }`}
                />
                <span className="font-mono text-sm text-txt-strong">
                  {data.steward.configured
                    ? data.steward.connected
                      ? t("cloud.elizaWallet.connected", {
                          defaultValue: "Connected",
                        })
                      : t("cloud.elizaWallet.disconnected", {
                          defaultValue: "Configured (disconnected)",
                        })
                    : t("cloud.elizaWallet.notConfigured", {
                        defaultValue: "Not configured",
                      })}
                </span>
              </div>
            </div>
            {data.steward.version && (
              <div className="px-4 py-3 grid grid-cols-[80px_1fr] gap-4 items-center">
                <p className="font-mono text-xs-tight uppercase tracking-[0.2em] text-muted">
                  {t("cloud.elizaWallet.version", { defaultValue: "Version" })}
                </p>
                <span className="font-mono text-sm text-txt-strong">
                  {data.steward.version}
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Balances */}
      {data.balances?.evm && data.balances.evm.length > 0 && (
        <div>
          <SectionHeader
            label={t("cloud.elizaWallet.balances", {
              defaultValue: "Balances",
            })}
          />
          <div className="space-y-2">
            {data.balances.evm.map((chain) => (
              <div
                key={chain.chainId}
                className="border border-border bg-card"
              >
                <div className="px-4 py-2 border-b border-border flex items-center justify-between">
                  <span className="font-mono text-xs-tight uppercase tracking-[0.2em] text-muted">
                    {chain.chainName} ({chain.chainId})
                  </span>
                </div>
                <div className="divide-y divide-border">
                  <div className="px-4 py-2.5 flex items-center justify-between">
                    <span className="font-mono text-xs text-muted-strong">
                      {chain.nativeSymbol ?? "ETH"}
                    </span>
                    <div className="text-right">
                      <span className="font-mono text-sm text-txt-strong tabular-nums">
                        {formatNative(chain.nativeBalance, chain.nativeSymbol)}
                      </span>
                      {chain.nativeUsdValue != null && (
                        <span className="font-mono text-xs-tight text-muted ml-2">
                          {formatUsd(chain.nativeUsdValue)}
                        </span>
                      )}
                    </div>
                  </div>
                  {chain.tokens?.map((token) => (
                    <div
                      key={token.symbol}
                      className="px-4 py-2.5 flex items-center justify-between"
                    >
                      <span className="font-mono text-xs text-muted-strong">
                        {token.symbol}
                      </span>
                      <div className="text-right">
                        <span className="font-mono text-sm text-txt-strong tabular-nums">
                          {token.balance} {token.symbol}
                        </span>
                        {token.usdValue != null && (
                          <span className="font-mono text-xs-tight text-muted ml-2">
                            {formatUsd(token.usdValue)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Live indicator */}
      <div className="flex items-center gap-2 pt-1">
        <span className="w-1.5 h-1.5 rounded-full bg-status-success animate-pulse motion-reduce:animate-none" />
        <span className="font-mono text-2xs text-muted tracking-wide">
          {t("cloud.elizaWallet.liveIndicator", { defaultValue: "LIVE · 30S" })}
        </span>
      </div>
    </div>
  );
}
