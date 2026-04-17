import type {
  WalletBalancesResponse,
  WalletNftsResponse,
} from "@elizaos/shared/contracts/wallet";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui";
import type { createTranslator } from "../../i18n";
import type { AppState } from "../../state/types";
import { CHAIN_CONFIGS, PRIMARY_CHAIN_KEYS } from "./chainConfig";

type InventoryToolbarStateKey = "inventoryView" | "inventorySort";
type InventorySort = AppState["inventorySort"];
type InventoryView = AppState["inventoryView"];

function isInventorySort(value: string): value is InventorySort {
  return value === "value" || value === "chain" || value === "symbol";
}

export interface WalletToolbarAddress {
  label: string;
  address: string;
}

export interface InventoryToolbarProps {
  t: ReturnType<typeof createTranslator>;
  totalUsd: number;
  inventoryView: InventoryView;
  inventorySort: InventorySort;
  chainFocus: string;
  walletBalances: WalletBalancesResponse | null;
  walletNfts: WalletNftsResponse | null;
  /** Shown on every wallet screen so users can fund the agent even when the token table is non-empty. */
  addresses?: WalletToolbarAddress[];
  onCopyAddress?: (address: string) => void | Promise<void>;
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
  addresses = [],
  onCopyAddress,
  setState,
  onChainChange,
  loadBalances,
  loadNfts,
}: InventoryToolbarProps) {
  const showCopyRow =
    addresses.length > 0 && typeof onCopyAddress === "function";

  return (
    <div className="space-y-2 pb-3">
      <div className="flex flex-wrap items-center gap-2">
        <div
          className="mr-auto text-xl font-bold text-txt-strong"
          data-testid="wallet-balance-value"
        >
          {totalUsd > 0
            ? `$${totalUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "$0.00"}
        </div>

        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
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
          </Button>
          <Button
            variant="ghost"
            size="sm"
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
          </Button>
        </div>

        <Select
          value={chainFocus}
          onValueChange={(value: string) => onChainChange(value)}
        >
          <SelectTrigger
            data-testid="wallet-chain-select"
            aria-label={t("wallet.chain")}
            className="h-8 min-w-32 border border-border bg-bg px-2.5 text-xs text-txt"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("wallet.all")}</SelectItem>
            {PRIMARY_CHAIN_KEYS.map((key) => (
              <SelectItem key={key} value={key}>
                {CHAIN_CONFIGS[key].name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {inventoryView === "tokens" && (
          <Select
            value={inventorySort}
            onValueChange={(nextSort: string) => {
              if (isInventorySort(nextSort)) {
                setState("inventorySort", nextSort);
              }
            }}
          >
            <SelectTrigger
              data-testid="wallet-sort-select"
              aria-label={t("wallet.sort")}
              className="h-8 min-w-28 border border-border bg-bg px-2.5 text-xs text-txt"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="value">{t("wallet.value")}</SelectItem>
              <SelectItem value="chain">{t("wallet.chain")}</SelectItem>
              <SelectItem value="symbol">{t("wallet.name")}</SelectItem>
            </SelectContent>
          </Select>
        )}

        <Button
          variant="outline"
          size="sm"
          className="h-8 px-3 text-xs shadow-sm hover:border-accent hover:text-txt"
          onClick={() =>
            inventoryView === "tokens" ? loadBalances() : loadNfts()
          }
        >
          {t("common.refresh")}
        </Button>
      </div>

      {showCopyRow ? (
        <div
          className="flex flex-wrap items-center gap-2"
          data-testid="wallet-address-copy-row"
        >
          <span className="text-xs-tight text-muted w-full sm:w-auto">
            {t("wallet.receiveHint")}
          </span>
          <div className="flex flex-wrap items-center gap-2">
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
        </div>
      ) : null}
    </div>
  );
}
