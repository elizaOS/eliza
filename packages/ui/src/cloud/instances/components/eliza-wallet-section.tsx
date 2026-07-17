"use client";

/**
 * Wallet section of the cloud agent-instance detail: balance and wallet actions,
 * polled while the document is visible.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CopyButton } from "../../../components/ui/copy-button";
import { useIntervalWhenDocumentVisible } from "../../../hooks/useDocumentVisibility";
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
    return `Unavailable ${symbol}`;
  }
}

function formatUsd(val?: number): string {
  if (val == null) return "";
  return `$${val.toFixed(2)}`;
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
        // error-policy:J4 steward status is an optional panel section. The
        // required address and balance results drive primary error rendering.
        fetch(`${base}/steward-status`)
          // error-policy:J4 steward status is an optional wallet sub-panel; a
          // failed/absent status degrades to null (the "no steward" render). The
          // required address/balance fetches above reject and surface via their
          // allSettled rejection handling below.
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);

      if (!mountedRef.current) return;

      if (addrRes.status === "rejected" || balRes.status === "rejected") {
        // Narrow per-branch: with only the disjunction guard, TS cannot prove
        // either settled result is the rejected one, so .reason is invalid.
        const reason =
          addrRes.status === "rejected" ? addrRes.reason : balRes.reason;
        setError(
          reason instanceof Error
            ? reason.message
            : t("cloud.elizaWallet.loadFailed", {
                defaultValue: "Couldn't load wallet details",
              }),
        );
        return;
      }

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
    const errorTitle = t("cloud.elizaWallet.loadFailed", {
      defaultValue: "Couldn't load wallet details",
    });
    return (
      <div
        className="flex items-start justify-between gap-4 border border-destructive/20 bg-destructive-subtle p-4"
        role="alert"
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-destructive">{errorTitle}</p>
          {error !== errorTitle ? (
            <p className="mt-1 break-words text-xs text-destructive/70">
              {error}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          className="min-h-touch shrink-0 px-3 text-xs font-medium text-destructive underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            setLoading(true);
            void fetchData();
          }}
        >
          {t("cloud.elizaWallet.retry", { defaultValue: "Try again" })}
        </button>
      </div>
    );
  }

  const hasEvm = Boolean(data.addresses?.evmAddress);
  const hasSolana = Boolean(data.addresses?.solanaAddress);

  if (!hasEvm && !hasSolana) {
    return (
      <div className="border border-border bg-card px-6 py-8 text-center">
        <p className="text-sm font-medium text-txt-strong">
          {t("cloud.elizaWallet.noWallets", {
            defaultValue: "No wallet addresses yet",
          })}
        </p>
        <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted">
          {t("cloud.elizaWallet.noWalletsHint", {
            defaultValue:
              "Wallet addresses appear here after this agent finishes setting up.",
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
                <CopyButton
                  value={data.addresses?.evmAddress ?? ""}
                  feedbackDuration={1500}
                  copyLabel={t("cloud.elizaWallet.copy", {
                    defaultValue: "Copy",
                  })}
                  copiedLabel="Copied"
                  className="ml-1.5 shrink-0"
                />
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
                <CopyButton
                  value={data.addresses?.solanaAddress ?? ""}
                  feedbackDuration={1500}
                  copyLabel={t("cloud.elizaWallet.copy", {
                    defaultValue: "Copy",
                  })}
                  copiedLabel="Copied"
                  className="ml-1.5 shrink-0"
                />
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
              <div key={chain.chainId} className="border border-border bg-card">
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
      <div className="flex items-center gap-2 pt-1" role="status">
        <span
          aria-hidden="true"
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-success motion-reduce:animate-none"
        />
        <span className="text-xs text-muted">
          {t("cloud.elizaWallet.liveIndicator", {
            defaultValue: "Live balances, refreshed every 30 seconds",
          })}
        </span>
      </div>
    </div>
  );
}
