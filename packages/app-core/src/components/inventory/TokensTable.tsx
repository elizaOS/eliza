import type { EvmChainBalance } from "@elizaos/shared/contracts/wallet";
import { Button } from "@elizaos/ui";
import type { createTranslator } from "../../i18n";
import { chainIcon, formatBalance, type TokenRow } from "./constants";
import { TokenLogo } from "./TokenLogo";

export interface TokensTableProps {
  t: ReturnType<typeof createTranslator>;
  walletLoading: boolean;
  walletBalances: unknown;
  visibleRows: TokenRow[];
  visibleChainErrors: EvmChainBalance[];
  showChainColumn: boolean;
  handleUntrackToken: (address: string) => void;
}

export function TokensTable({
  t,
  walletLoading,
  walletBalances,
  visibleRows,
  visibleChainErrors,
  showChainColumn,
  handleUntrackToken,
}: TokensTableProps) {
  const renderChainErrors = () =>
    visibleChainErrors.length > 0 ? (
      <div className="mt-1 text-xs-tight text-muted px-3 pb-2">
        {visibleChainErrors.map((chain: EvmChainBalance) => {
          const icon = chainIcon(chain.chain);
          return (
            <div key={chain.chain} className="py-0.5">
              <span
                className={`inline-block w-3 h-3 rounded-full text-center leading-3 text-3xs font-bold font-mono text-white align-middle ${icon.cls}`}
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
      <div className="flex min-h-[14rem] items-center justify-center px-6 py-8 text-center text-sm text-muted">
        {t("wallet.loadingBalances")}
      </div>
    );
  }

  if (visibleRows.length === 0) {
    const showFundingCta = !walletBalances;
    return (
      <div className="flex min-h-[14rem] flex-1 flex-col items-center justify-center gap-4 px-6 py-8 text-center">
        <div className="max-w-md space-y-2">
          <div className="text-base font-medium text-txt-strong">
            {walletBalances
              ? t("wallet.noTokensFound")
              : t("wallet.noDataRefresh")}
          </div>
          {showFundingCta ? (
            <div className="text-sm text-muted">
              {t("wallet.emptyTokensCta")}
            </div>
          ) : null}
        </div>
        {renderChainErrors()}
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] border-collapse">
          <thead>
            <tr className="bg-bg/24">
              <th className="pl-3 pr-2 py-2 text-left w-12" />
              <th className="px-3 py-2 text-left text-2xs text-muted font-bold uppercase tracking-wide">
                {t("wallet.table.token")}
              </th>
              <th className="px-3 py-2 text-right text-2xs text-muted font-bold uppercase tracking-wide">
                {t("wallet.table.balance")}
              </th>
              <th className="px-3 py-2 text-right text-2xs text-muted font-bold uppercase tracking-wide">
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
                  className="hover:bg-bg-hover/65 transition-colors"
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
                        <div className="text-2xs text-muted leading-tight mt-0.5">
                          {row.isNative ? (
                            <span className="rounded-full border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-3xs text-accent">
                              {t("tokenstable.nativeGas")}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1">
                              <span className="truncate max-w-[160px] inline-block">
                                {row.name}
                              </span>
                              {row.isTracked && (
                                <span className="rounded-full border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-3xs text-accent">
                                  {t("wallet.manual")}
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                      {showChainColumn && (
                        <span className="shrink-0 rounded-full border border-border/50 px-1.5 py-0.5 text-3xs font-mono text-muted">
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
                    {row.valueUsd >= 0.01
                      ? `$${row.valueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                      : "\u2014"}
                  </td>
                  {/* Actions */}
                  <td className="pl-2 pr-3 py-3 align-middle whitespace-nowrap text-right">
                    {row.isTracked && contractAddress && (
                      <Button
                        variant="link"
                        size="sm"
                        data-testid="wallet-token-untrack"
                        className="h-auto cursor-pointer p-0 text-2xs text-danger hover:underline"
                        title={t("wallet.removeManualTitle")}
                        onClick={() => handleUntrackToken(contractAddress)}
                      >
                        {t("wallet.remove")}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {renderChainErrors()}
    </div>
  );
}
