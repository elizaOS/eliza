/**
 * Unified wallet header row: total, view toggle, chain filter, sort, refresh.
 */

import type {
  WalletBalancesResponse,
  WalletNftsResponse,
} from "@elizaos/app-core/api";
import type { createTranslator } from "@elizaos/app-core/i18n";
import type { AppState } from "@elizaos/app-core/state";
import { Button } from "@elizaos/ui";
import { CHAIN_CONFIGS, PRIMARY_CHAIN_KEYS } from "../chainConfig";

type InventoryToolbarStateKey = "inventoryView" | "inventorySort";
type InventorySort = AppState["inventorySort"];
type InventoryView = AppState["inventoryView"];

function isInventorySort(value: string): value is InventorySort {
  return value === "value" || value === "chain" || value === "symbol";
}

export interface InventoryToolbarProps {
  t: ReturnType<typeof createTranslator>;
  totalUsd: number;
  inventoryView: InventoryView;
  inventorySort: InventorySort;
  chainFocus: string;
  walletBalances: WalletBalancesResponse | null;
  walletNfts: WalletNftsResponse | null;
  setState: <K extends InventoryToolbarStateKey>(
    key: K,
    value: AppState[K],
  ) => void;
  onChainChange: (chain: string) => void;
  loadBalances: () => Promise<void> | void;
  loadNfts: () => Promise<void> | void;
}

export function InventoryToolbar({
  t,
  totalUsd,
  inventoryView,
  inventorySort,
  chainFocus,
  walletBalances,
  walletNfts,
  setState,
  onChainChange,
  loadBalances,
  loadNfts,
}: InventoryToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border pb-3">
      <div
        className="mr-auto text-[22px] font-bold text-txt-strong"
        data-testid="wallet-balance-value"
      >
        {totalUsd > 0
          ? `$${totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          : "$0.00"}
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          data-testid="wallet-view-tokens"
          className={`h-8 border-b-2 px-2 text-xs font-medium cursor-pointer ${
            inventoryView === "tokens"
              ? "border-accent text-txt-strong"
              : "border-transparent text-muted hover:text-txt"
          }`}
          onClick={() => {
            setState("inventoryView", "tokens");
            if (!walletBalances) void loadBalances();
          }}
        >
          {t("wallet.tokens")}
        </button>
        <button
          type="button"
          data-testid="wallet-view-nfts"
          className={`h-8 border-b-2 px-2 text-xs font-medium cursor-pointer ${
            inventoryView === "nfts"
              ? "border-accent text-txt-strong"
              : "border-transparent text-muted hover:text-txt"
          }`}
          onClick={() => {
            setState("inventoryView", "nfts");
            if (!walletNfts) void loadNfts();
          }}
        >
          {t("wallet.nfts")}
        </button>
      </div>

      <select
        data-testid="wallet-chain-select"
        aria-label={t("wallet.chain")}
        className="h-8 min-w-32 border border-border bg-bg px-2.5 text-xs text-txt"
        value={chainFocus}
        onChange={(event) => onChainChange(event.target.value)}
      >
        <option value="all">{t("wallet.all")}</option>
        {PRIMARY_CHAIN_KEYS.map((key) => (
          <option key={key} value={key}>
            {CHAIN_CONFIGS[key].name}
          </option>
        ))}
      </select>

      {inventoryView === "tokens" && (
        <select
          data-testid="wallet-sort-select"
          aria-label={t("wallet.sort")}
          className="h-8 min-w-28 border border-border bg-bg px-2.5 text-xs text-txt"
          value={inventorySort}
          onChange={(event) => {
            const nextSort = event.target.value;
            if (isInventorySort(nextSort)) {
              setState("inventorySort", nextSort);
            }
          }}
        >
          <option value="value">{t("wallet.value")}</option>
          <option value="chain">{t("wallet.chain")}</option>
          <option value="symbol">{t("wallet.name")}</option>
        </select>
      )}

      <Button
        variant="outline"
        size="sm"
        className="h-8 px-3 text-xs shadow-sm hover:border-accent hover:text-txt"
        onClick={() =>
          inventoryView === "tokens" ? loadBalances() : loadNfts()
        }
      >
        {t("appsview.Refresh")}
      </Button>
    </div>
  );
}
