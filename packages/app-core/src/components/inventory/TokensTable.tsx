/**
 * Token balance table with per-chain error notices.
 */

import type { EvmChainBalance } from "@elizaos/app-core/api";
import type { createTranslator } from "@elizaos/app-core/i18n";
import { Button } from "@elizaos/ui";
import { chainIcon, formatBalance, type TokenRow } from "./constants";
import { TokenLogo } from "./TokenLogo";

interface WalletCopyAddress {
  label: string;
  address: string;
}

export interface TokensTableProps {
  t: ReturnType<typeof createTranslator>;
  walletLoading: boolean;
  walletBalances: unknown;
  visibleRows: TokenRow[];
  visibleChainErrors: EvmChainBalance[];
  inventoryChainFocus: string;
  addresses: WalletCopyAddress[];
  onCopyAddress: (address: string) => Promise<void> | void;
  handleUntrackToken: (address: string) => void;
}

export function TokensTable({
  t,
  walletLoading,
  walletBalances,
  visibleRows,
  visibleChainErrors,
  inventoryChainFocus,
  addresses,
  onCopyAddress,
  handleUntrackToken,
}: TokensTableProps) {
  const renderChainErrors = () =>
    visibleChainErrors.length > 0 ? (
      <div className="mt-1 text-[11px] text-muted px-3 pb-2">
        {visibleChainErrors.map((chain: EvmChainBalance) => {
          const icon = chainIcon(chain.chain);
          return (
            <div key={chain.chain} className="py-0.5">
              <span
                className={`inline-block w-3 h-3 rounded-full text-center leading-3 text-[7px] font-bold font-mono text-white align-middle ${icon.cls}`}
              >
                {icon.code}
              </span>{" "}
              {chain.chain}:{" "}
              {chain.error?.includes("not enabled") ? (
                <>
                  data source not enabled &mdash;{" "}
                  <a
                    href="https://dashboard.alchemy.com/"
                    target="_blank"
                    rel="noopener"
                    className="text-txt"
                  >
                    {t("wallet.enableIt")}
                  </a>
                </>
              ) : (
                chain.error
              )}
            </div>
          );
        })}
      </div>
    ) : null;

  if (walletLoading) {
    return (
      <div className="text-center py-10 text-muted italic text-xs">
        {t("wallet.loadingBalances")}
      </div>
    );
  }

  if (visibleRows.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 text-center">
        <div className="max-w-md space-y-2">
          <div className="text-base font-medium text-txt-strong">
            {walletBalances
              ? t("wallet.noTokensFound")
              : t("wallet.noDataRefresh")}
          </div>
          <div className="text-xs text-muted">{t("wallet.emptyTokensCta")}</div>
        </div>
        {addresses.length > 0 && (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {addresses.map((item) => (
              <Button
                key={`${item.label}-${item.address}`}
                variant="outline"
                size="sm"
                data-testid={`wallet-copy-${item.label.toLowerCase()}-address`}
                className="h-8 px-3 text-xs shadow-sm hover:border-accent hover:text-txt"
                onClick={() => void onCopyAddress(item.address)}
              >
                {item.label === "EVM"
                  ? t("wallet.copyEvmAddress")
                  : t("wallet.copySolanaAddress")}
              </Button>
            ))}
          </div>
        )}
        {renderChainErrors()}
      </div>
    );
  }

  return (
    <>
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="pl-3 pr-2 py-2 text-left w-12" />
            <th className="px-3 py-2 text-left text-[10px] text-muted font-bold uppercase tracking-wide">
              {t("wallet.table.token")}
            </th>
            <th className="px-3 py-2 text-right text-[10px] text-muted font-bold uppercase tracking-wide">
              {t("wallet.table.balance")}
            </th>
            <th className="px-3 py-2 text-right text-[10px] text-muted font-bold uppercase tracking-wide">
              {t("wallet.value")}
            </th>
            <th className="pl-3 pr-3 py-2 text-right w-24" />
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row) => {
            const contractAddress = row.contractAddress;
            return (
              <tr
                key={`${row.chain}-${row.symbol}-${row.contractAddress ?? ""}`}
                className="border-b border-border last:border-b-0 hover:bg-bg-hover transition-colors"
              >
                {/* Logo */}
                <td className="pl-3 pr-2 py-3 align-middle">
                  <TokenLogo
                    symbol={row.symbol}
                    chain={row.chain}
                    contractAddress={contractAddress}
                    preferredLogoUrl={row.logoUrl}
                    size={32}
                  />
                </td>
                {/* Symbol + name */}
                <td className="px-3 py-3 align-middle">
                  <div className="flex items-center gap-2">
                    <div>
                      <div className="text-sm font-bold font-mono leading-tight">
                        {row.symbol}
                      </div>
                      <div className="text-[10px] text-muted leading-tight mt-0.5">
                        {row.isNative ? (
                          <span className="text-[9px] bg-accent/15 text-accent px-1 py-0.5 rounded">
                            {t("tokenstable.nativeGas")}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1">
                            <span className="truncate max-w-[160px] inline-block">
                              {row.name}
                            </span>
                            {row.isTracked && (
                              <span className="text-[9px] bg-accent/15 text-accent px-1 py-0.5 rounded">
                                {t("wallet.manual")}
                              </span>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                    {inventoryChainFocus === "all" && (
                      <span className="text-[9px] text-muted font-mono border border-border px-1 py-0.5 rounded shrink-0">
                        {row.chain}
                      </span>
                    )}
                  </div>
                </td>
                {/* Balance */}
                <td className="px-3 py-3 align-middle font-mono text-sm text-right whitespace-nowrap">
                  {formatBalance(row.balance)}
                </td>
                {/* Value */}
                <td className="px-3 py-3 align-middle font-mono text-sm text-right text-muted whitespace-nowrap">
                  {row.valueUsd > 0
                    ? `$${row.valueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                    : "\u2014"}
                </td>
                {/* Actions */}
                <td className="pl-2 pr-3 py-3 align-middle whitespace-nowrap text-right">
                  {row.isTracked && contractAddress && (
                    <button
                      type="button"
                      data-testid="wallet-token-untrack"
                      className="text-[10px] text-danger hover:underline cursor-pointer bg-transparent border-none p-0"
                      title={t("wallet.removeManualTitle")}
                      onClick={() => handleUntrackToken(contractAddress)}
                    >
                      {t("wallet.remove")}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {renderChainErrors()}
    </>
  );
}
