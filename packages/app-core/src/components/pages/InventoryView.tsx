import type { StewardStatusResponse } from "@elizaos/app-steward/types/steward";
import { useApp } from "../../state/useApp";
import { WidgetHost } from "../../widgets";

import {
  AlertTriangle,
  ChevronDown,
  Copy,
  Link,
  RefreshCw,
  Settings,
  Shield,
  Unlink,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BSC_GAS_READY_THRESHOLD,
  loadTrackedBscTokens,
  loadTrackedTokens,
  removeTrackedBscToken,
  saveTrackedTokens,
  type TrackedToken,
} from "../inventory";
import { TradePanel } from "../inventory/BscTradePanel";
import { ChainIcon } from "../inventory/ChainIcon";
import {
  CHAIN_CONFIGS,
  type ChainKey,
  chainKeyToWalletRpcChain,
  PRIMARY_CHAIN_KEYS,
  resolveChainKey,
} from "../inventory/chainConfig";
import {
  type PrimaryInventoryChainKey,
  toggleInventoryChainFilter,
} from "../inventory/inventory-chain-filters";
import { NftGrid } from "../inventory/NftGrid";
import { TokensTable } from "../inventory/TokensTable";
import { useInventoryData } from "../inventory/useInventoryData";
import { PolicyControlsView } from "../settings/PolicyControlsView";
import { ApprovalQueue } from "@elizaos/app-steward/ApprovalQueue";
import { TransactionHistory } from "@elizaos/app-steward/TransactionHistory";
import { ConfigPageView } from "./ConfigPageView";
import { PagePanel, SidebarContent, SidebarFilterBar, SidebarHeader, SidebarPanel, Sidebar, SidebarScrollRegion, Button, Dialog, DialogContent, DialogHeader, DialogTitle, SegmentedControl, TooltipHint, PageLayout } from "@elizaos/ui";

/* ── Component ─────────────────────────────────────────────────────── */

/* ── Wallet Settings Popup Components ────────────────────────────────── */

function SettingsCopyableAddress({
  label,
  address,
}: {
  label: string;
  address: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [address]);

  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border/50 bg-bg/50 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs-tight font-medium text-muted">{label}</div>
        <div className="mt-0.5 truncate font-mono text-xs text-txt">
          {address}
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 shrink-0 text-muted hover:text-txt"
        onClick={handleCopy}
        aria-label={`Copy ${label} address`}
      >
        {copied ? (
          <span className="text-ok text-xs">✓</span>
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </Button>
    </div>
  );
}

function StewardWalletInfoPopup({
  stewardStatus,
  onOpenPolicies,
}: {
  stewardStatus: StewardStatusResponse;
  onOpenPolicies: () => void;
}) {
  const { t } = useApp();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const evmAddress =
    stewardStatus.walletAddresses?.evm ?? stewardStatus.evmAddress ?? null;
  const solanaAddress = stewardStatus.walletAddresses?.solana ?? null;

  return (
    <div className="space-y-4">
      {/* Steward status banner */}
      <div className="flex items-center gap-3 rounded-lg border border-accent/20 bg-accent/5 p-3">
        <Shield className="h-5 w-5 shrink-0 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-txt">
            {t("settings.stewardWalletManaged", {
              defaultValue: "Wallet managed by Steward",
            })}
          </div>
          <div className="mt-0.5 text-xs-tight text-muted">
            {stewardStatus.vaultHealth === "ok"
              ? t("settings.stewardVaultHealthy", {
                  defaultValue: "Vault connected and healthy",
                })
              : stewardStatus.vaultHealth === "degraded"
                ? t("settings.stewardVaultDegraded", {
                    defaultValue: "Vault connected - degraded",
                  })
                : t("settings.stewardVaultError", {
                    defaultValue: "Vault connected - error state",
                  })}
          </div>
        </div>
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            stewardStatus.vaultHealth === "ok"
              ? "bg-ok"
              : stewardStatus.vaultHealth === "degraded"
                ? "bg-warn"
                : "bg-danger"
          }`}
        />
      </div>

      {/* Wallet addresses */}
      <div className="space-y-2">
        {evmAddress && (
          <SettingsCopyableAddress label="EVM Address" address={evmAddress} />
        )}
        {solanaAddress && (
          <SettingsCopyableAddress
            label="Solana Address"
            address={solanaAddress}
          />
        )}
        {!evmAddress && !solanaAddress && (
          <div className="rounded-lg border border-border/50 bg-bg/50 px-3 py-2.5 text-xs text-muted">
            {t("settings.stewardNoAddresses", {
              defaultValue: "No vault addresses yet",
            })}
          </div>
        )}
      </div>

      {/* Link to Wallet Policies */}
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-center gap-2 text-xs"
        onClick={onOpenPolicies}
      >
        <Shield className="h-3.5 w-3.5" />
        {t("settings.viewWalletPolicies", {
          defaultValue: "View Wallet Policies",
        })}
      </Button>

      {/* RPC configuration */}
      <div className="pt-4">
        <div className="text-xs font-semibold text-txt mb-2">
          {t("settings.rpcConfiguration", {
            defaultValue: "RPC Configuration",
          })}
        </div>
        <ConfigPageView embedded />
      </div>

      {/* Advanced: show local key import */}
      <div className="pt-3">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-between text-xs text-muted hover:text-txt"
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {t("settings.showAdvancedKeyManagement", {
            defaultValue: "Advanced key management",
          })}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
          />
        </Button>
        {showAdvanced && (
          <div className="mt-3 rounded-lg border border-warn/20 bg-warn/5 p-3">
            <div className="mb-2 flex items-center gap-2 text-xs-tight text-warn">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t("settings.advancedKeyWarning", {
                defaultValue: "Not needed with Steward. Use with caution.",
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

type InventorySortKey = "chain" | "symbol" | "value";
type WalletSubTab = "balances" | "transactions" | "approvals";

function countVisibleAssetsForFocus(
  focus: ChainKey,
  rows:
    | Array<{
        chain: string;
        balanceRaw: number;
        valueUsd: number;
        isTracked?: boolean;
      }>
    | undefined,
): number {
  return (rows ?? []).filter((row) => {
    const hasBalance = row.isTracked || row.balanceRaw > 0 || row.valueUsd > 0;
    if (!hasBalance) return false;
    return resolveChainKey(row.chain) === focus;
  }).length;
}

function isInventorySortKey(value: string): value is InventorySortKey {
  return value === "value" || value === "chain" || value === "symbol";
}

export function InventoryView() {
  const {
    walletConfig,
    walletAddresses,
    walletBalances,
    walletNfts,
    walletLoading,
    walletNftsLoading,
    inventoryView,
    inventorySort,
    inventorySortDirection,
    inventoryChainFilters,
    walletError,
    loadBalances,
    loadNfts,
    elizaCloudConnected,
    setTab,
    setState,
    setActionNotice,
    executeBscTrade,
    getBscTradePreflight,
    getBscTradeQuote,
    getBscTradeTxStatus,
    getStewardStatus,
    getStewardHistory,
    getStewardPending,
    approveStewardTx,
    rejectStewardTx,
    copyToClipboard,
    vincentConnected,
    vincentLoginBusy,
    vincentLoginError,
    handleVincentLogin,
    handleVincentDisconnect,
    t,
  } = useApp();

  // ── Tracked tokens state ──────────────────────────────────────────
  const [trackedTokens, setTrackedTokens] = useState<TrackedToken[]>(() =>
    loadTrackedTokens(),
  );
  const [trackedBscTokens, setTrackedBscTokens] =
    useState(loadTrackedBscTokens);

  // ── Wallet sub-tab (balances / transactions / approvals) ────────
  const [walletSubTab, setWalletSubTab] = useState<WalletSubTab>("balances");
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [walletSearch, setWalletSearch] = useState("");

  // ── Wallet settings popup state ──────────────────────────────────
  const [walletRpcOpen, setWalletRpcOpen] = useState(false);
  const [walletPoliciesOpen, setWalletPoliciesOpen] = useState(false);
  const autoLoadedInventoryViewRef = useRef<"tokens" | "nfts" | null>(null);

  const handlePendingCountChange = useCallback((count: number) => {
    setPendingApprovalCount(count);
  }, []);

  // ── Steward status ────────────────────────────────────────────────
  const [stewardStatus, setStewardStatus] =
    useState<StewardStatusResponse | null>(null);

  useEffect(() => {
    if (typeof getStewardStatus !== "function") {
      return;
    }

    let cancelled = false;
    getStewardStatus()
      .then((s) => {
        if (!cancelled) setStewardStatus(s);
      })
      .catch(() => {
        /* steward not available — ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [getStewardStatus]);

  useEffect(() => {
    if (autoLoadedInventoryViewRef.current === inventoryView) {
      return;
    }
    autoLoadedInventoryViewRef.current = inventoryView;

    if (inventoryView === "tokens") {
      if (!walletBalances && !walletLoading) {
        void loadBalances();
      }
      return;
    }

    if (!walletNfts && !walletNftsLoading) {
      void loadNfts();
    }
  }, [
    inventoryView,
    loadBalances,
    loadNfts,
    walletBalances,
    walletLoading,
    walletNfts,
    walletNftsLoading,
  ]);

  // ── RPC + wallet readiness ───────────────────────────────────────
  const cfg = walletConfig;
  const hasManagedBscRpc = Boolean(cfg?.managedBscRpcReady);
  const cloudManagedAccess = Boolean(
    cfg?.cloudManagedAccess || elizaCloudConnected,
  );

  const goToRpcSettings = useCallback(() => {
    setWalletRpcOpen(true);
  }, []);

  // ── Derived data (hook) ───────────────────────────────────────────
  const {
    singleChainFocus,
    tokenRowsAllChains,
    allNfts,
    focusedChainError,
    focusedChainName,
    visibleRows,
    visibleChainErrors,
    focusedNativeBalance,
  } = useInventoryData({
    walletBalances,
    walletAddresses,
    walletConfig,
    walletNfts,
    inventorySort,
    inventorySortDirection,
    inventoryChainFilters,
    trackedBscTokens,
    trackedTokens,
  });

  const walletSearchQuery = walletSearch.trim().toLowerCase();
  const filteredVisibleRows = useMemo(() => {
    if (!walletSearchQuery) return visibleRows;
    return visibleRows.filter((row) => {
      const haystacks = [
        row.symbol,
        row.name,
        row.chain,
        row.contractAddress ?? "",
      ];
      return haystacks.some((value) =>
        value.toLowerCase().includes(walletSearchQuery),
      );
    });
  }, [visibleRows, walletSearchQuery]);

  const filteredNfts = useMemo(() => {
    if (!walletSearchQuery) return allNfts;
    return allNfts.filter((nft) => {
      const haystacks = [nft.name, nft.collectionName, nft.chain];
      return haystacks.some((value) =>
        value.toLowerCase().includes(walletSearchQuery),
      );
    });
  }, [allNfts, walletSearchQuery]);

  const evmAddr = walletAddresses?.evmAddress ?? walletConfig?.evmAddress;
  const solAddr = walletAddresses?.solanaAddress ?? walletConfig?.solanaAddress;
  const loadedEvmChainKeys = new Set(
    (walletBalances?.evm?.chains ?? [])
      .filter((chain) => !chain.error)
      .map((chain) => resolveChainKey(chain.chain))
      .filter((chainKey): chainKey is ChainKey => chainKey !== null),
  );
  const evmChainErrors = new Map(
    (walletBalances?.evm?.chains ?? [])
      .map((chain) => [resolveChainKey(chain.chain), chain.error] as const)
      .filter((entry): entry is [ChainKey, string | null] => entry[0] !== null),
  );
  const ethereumReady = Boolean(
    evmAddr &&
      !evmChainErrors.get("ethereum") &&
      (loadedEvmChainKeys.has("ethereum") ||
        cfg?.ethereumBalanceReady ||
        cfg?.alchemyKeySet ||
        cloudManagedAccess),
  );
  const baseReady = Boolean(
    evmAddr &&
      !evmChainErrors.get("base") &&
      (loadedEvmChainKeys.has("base") ||
        cfg?.baseBalanceReady ||
        cfg?.alchemyKeySet ||
        cloudManagedAccess),
  );
  const bscReady = Boolean(
    evmAddr &&
      !evmChainErrors.get("bsc") &&
      (loadedEvmChainKeys.has("bsc") ||
        cfg?.bscBalanceReady ||
        cfg?.ankrKeySet ||
        hasManagedBscRpc),
  );
  const avaxReady = Boolean(
    evmAddr &&
      !evmChainErrors.get("avax") &&
      (loadedEvmChainKeys.has("avax") ||
        cfg?.avalancheBalanceReady ||
        cfg?.alchemyKeySet ||
        cloudManagedAccess),
  );
  const solanaReady = Boolean(
    solAddr &&
      (Boolean(walletBalances?.solana) ||
        cfg?.solanaBalanceReady ||
        cfg?.heliusKeySet ||
        cloudManagedAccess),
  );
  const bnbBalance = Number.parseFloat(focusedNativeBalance ?? "0") || 0;
  const tradeReady =
    singleChainFocus === "bsc" ? bnbBalance >= BSC_GAS_READY_THRESHOLD : true;
  // When steward is connected, use steward addresses for copy buttons
  const stewardEvmAddr = stewardStatus?.connected
    ? (stewardStatus.walletAddresses?.evm ?? stewardStatus.evmAddress ?? null)
    : null;
  const stewardSolAddr = stewardStatus?.connected
    ? (stewardStatus.walletAddresses?.solana ?? null)
    : null;
  const displayEvmAddr = stewardEvmAddr ?? evmAddr;
  const displaySolAddr = stewardSolAddr ?? solAddr;
  const addresses = [
    displayEvmAddr ? { label: "EVM", address: displayEvmAddr } : null,
    displaySolAddr ? { label: "Solana", address: displaySolAddr } : null,
  ].filter((item): item is { label: string; address: string } => Boolean(item));
  const chainItemMeta = useMemo(() => {
    const items: Array<{
      key: PrimaryInventoryChainKey;
      label: string;
      hasAddress: boolean;
      description: string;
    }> = [];

    for (const key of PRIMARY_CHAIN_KEYS) {
      const pk = key as PrimaryInventoryChainKey;
      const config = CHAIN_CONFIGS[key];
      const assetCount = countVisibleAssetsForFocus(key, tokenRowsAllChains);
      const chainReady =
        key === "ethereum"
          ? ethereumReady
          : key === "base"
            ? baseReady
            : key === "bsc"
              ? bscReady
              : key === "avax"
                ? avaxReady
                : key === "solana"
                  ? solanaReady
                  : false;
      const hasAddress = key === "solana" ? Boolean(solAddr) : Boolean(evmAddr);

      items.push({
        key: pk,
        label: config.name,
        hasAddress,
        description: !hasAddress
          ? "No wallet address yet"
          : chainReady
            ? assetCount > 0
              ? `${assetCount} visible assets`
              : "Connected and ready"
            : "Needs RPC setup",
      });
    }

    return items;
  }, [
    avaxReady,
    baseReady,
    bscReady,
    ethereumReady,
    evmAddr,
    solAddr,
    solanaReady,
    tokenRowsAllChains,
  ]);
  const walletSearchLabel = t("wallet.searchWallets", {
    defaultValue: "Search wallets",
  });
  const handleInventoryViewChange = useCallback(
    (nextView: "tokens" | "nfts") => {
      setState("inventoryView", nextView);
      if (nextView === "tokens") {
        if (!walletBalances) void loadBalances();
        return;
      }
      if (!walletNfts) {
        void loadNfts();
      }
    },
    [loadBalances, loadNfts, setState, walletBalances, walletNfts],
  );
  const handleInventoryChainToggle = useCallback(
    (chainKey: PrimaryInventoryChainKey) => {
      setState(
        "inventoryChainFilters",
        toggleInventoryChainFilter(inventoryChainFilters, chainKey),
      );
    },
    [inventoryChainFilters, setState],
  );

  const focusedChainLabel =
    focusedChainName ??
    (singleChainFocus
      ? (CHAIN_CONFIGS[singleChainFocus as keyof typeof CHAIN_CONFIGS]?.name ??
        singleChainFocus)
      : null);
  const inlineError =
    singleChainFocus && focusedChainError
      ? {
          message: `${focusedChainLabel ?? "Chain"}: ${focusedChainError}`,
          retryTitle: `Retry fetching ${focusedChainLabel ?? "chain"} balances`,
        }
      : null;

  const legacyRpcChain = singleChainFocus
    ? chainKeyToWalletRpcChain(singleChainFocus)
    : null;
  const headerWarning =
    singleChainFocus &&
    legacyRpcChain !== null &&
    cfg?.legacyCustomChains?.includes(legacyRpcChain)
      ? {
          title: `${
            focusedChainLabel ??
            (singleChainFocus === "bsc"
              ? "BSC"
              : singleChainFocus === "solana"
                ? "Solana"
                : "EVM")
          } is using legacy raw RPC config.`,
          body: "Re-save a supported provider in Settings to migrate fully.",
          actionLabel: t("wallet.setup.configureRpc"),
        }
      : singleChainFocus === "bsc" && evmAddr && !bscReady
        ? {
            title: t("wallet.setup.rpcNotConfigured"),
            body: t("portfolioheader.ConnectViaElizaCl"),
            actionLabel: t("wallet.setup.configureRpc"),
          }
        : singleChainFocus === "solana" && solAddr && !solanaReady
          ? {
              title: "Solana RPC is not configured.",
              body: "Connect via Eliza Cloud or configure HELIUS_API_KEY / SOLANA_RPC_URL in Settings to load Solana balances.",
              actionLabel: t("wallet.setup.configureRpc"),
            }
          : singleChainFocus &&
              singleChainFocus !== "bsc" &&
              singleChainFocus !== "solana" &&
              evmAddr &&
              !(singleChainFocus === "ethereum"
                ? ethereumReady
                : singleChainFocus === "base"
                  ? baseReady
                  : singleChainFocus === "avax"
                    ? avaxReady
                    : false)
            ? {
                title: `${focusedChainLabel ?? "Chain"} access is not configured.`,
                body: `Connect via Eliza Cloud or configure ${focusedChainLabel ?? "this chain"} RPC access in Settings to load balances.`,
                actionLabel: t("wallet.setup.configureRpc"),
              }
            : null;

  // ── Tracked token handlers ────────────────────────────────────────
  const handleAddToken = useCallback(
    (token: TrackedToken) => {
      const updated = [...trackedTokens, token];
      setTrackedTokens(updated);
      saveTrackedTokens(updated);
    },
    [trackedTokens],
  );

  const handleUntrackToken = useCallback(
    (address: string) => {
      const updated = trackedTokens.filter(
        (tk) => tk.address.toLowerCase() !== address.toLowerCase(),
      );
      setTrackedTokens(updated);
      saveTrackedTokens(updated);
      setTrackedBscTokens((prev) => removeTrackedBscToken(address, prev));
      setActionNotice(t("wallet.tokenRemovedManual"), "info", 2200);
    },
    [trackedTokens, setActionNotice, t],
  );

  const handleCopyAddress = useCallback(
    async (address: string) => {
      await copyToClipboard(address);
      setActionNotice(t("wallet.addressCopied"), "success", 2000);
    },
    [copyToClipboard, setActionNotice, t],
  );

  const walletSidebar = (
    <Sidebar
      testId="wallets-sidebar"
      contentIdentity={`wallets:${inventoryView}`}
      header={
        <SidebarHeader
          search={{
            value: walletSearch,
            onChange: (event) => setWalletSearch(event.target.value),
            onClear: () => setWalletSearch(""),
            placeholder: walletSearchLabel,
            "aria-label": walletSearchLabel,
          }}
        />
      }
      footer={
        <div className="flex w-full flex-col gap-2">
          {addresses.map((item) => (
            <Button
              key={`${item.label}-${item.address}`}
              variant="outline"
              size="sm"
              data-testid={`wallet-copy-${item.label.toLowerCase()}-address`}
              className="h-11 w-full justify-start rounded-xl px-4 text-xs font-semibold shadow-sm"
              onClick={() => void handleCopyAddress(item.address)}
            >
              <Copy className="h-4 w-4" />
              {item.label === "EVM"
                ? t("wallet.copyEvmAddress")
                : t("wallet.copySolanaAddress")}
            </Button>
          ))}

          {/* Wallet settings & policies popup triggers */}
          <Button
            variant="outline"
            size="sm"
            data-testid="wallet-rpc-popup"
            className="h-11 w-full justify-start rounded-xl px-4 text-xs font-semibold shadow-sm"
            onClick={() => setWalletRpcOpen(true)}
          >
            <Settings className="h-4 w-4" />
            {stewardStatus?.connected
              ? t("settings.sections.wallet.label", {
                  defaultValue: "Wallet",
                })
              : t("settings.sections.walletrpc.label", {
                  defaultValue: "Wallet & RPC",
                })}
          </Button>
          <Button
            variant="outline"
            size="sm"
            data-testid="wallet-policies-popup"
            className="h-11 w-full justify-start rounded-xl px-4 text-xs font-semibold shadow-sm"
            onClick={() => setWalletPoliciesOpen(true)}
          >
            <Shield className="h-4 w-4" />
            {t("settings.sections.walletpolicies.label", {
              defaultValue: "Wallet Policies",
            })}
          </Button>

          {/* Vincent moved to Apps → Vincent app */}
        </div>
      }
    >
      <SidebarScrollRegion>
        <SidebarPanel>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <SegmentedControl
                className="grid w-full grid-cols-2"
                buttonClassName="h-10 justify-center"
                value={inventoryView}
                onValueChange={handleInventoryViewChange}
                items={[
                  {
                    value: "tokens",
                    label: t("wallet.tokens"),
                    testId: "wallet-view-tokens",
                  },
                  {
                    value: "nfts",
                    label: t("wallet.nfts"),
                    testId: "wallet-view-nfts",
                  },
                ]}
              />
            </div>

            <SidebarFilterBar
              data-testid="wallet-sidebar-sort-block"
              selectValue={
                inventoryView === "nfts" && inventorySort === "value"
                  ? "symbol"
                  : inventorySort
              }
              selectOptions={[
                ...(inventoryView === "tokens"
                  ? [{ value: "value", label: t("wallet.value") }]
                  : []),
                { value: "chain", label: t("wallet.chain") },
                { value: "symbol", label: t("wallet.name") },
              ]}
              onSelectValueChange={(nextSort) => {
                if (!isInventorySortKey(nextSort)) return;
                setState("inventorySort", nextSort);
                setState(
                  "inventorySortDirection",
                  nextSort === "value" ? "desc" : "asc",
                );
              }}
              selectAriaLabel={t("wallet.sort")}
              selectTestId="wallet-sort-select"
              sortDirection={inventorySortDirection}
              onSortDirectionToggle={() =>
                setState(
                  "inventorySortDirection",
                  inventorySortDirection === "asc" ? "desc" : "asc",
                )
              }
              sortDirectionButtonTestId="wallet-sort-direction-toggle"
              sortAscendingLabel={t("wallet.sortAscending")}
              sortDescendingLabel={t("wallet.sortDescending")}
              refreshButtonTestId="wallet-refresh-balances"
              refreshLabel={t("common.refresh")}
              onRefresh={() =>
                void (inventoryView === "tokens" ? loadBalances() : loadNfts())
              }
            />

            <div>
              <SidebarContent.SectionLabel>
                {t("wallet.chain", { defaultValue: "Chain" })}
              </SidebarContent.SectionLabel>
              <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
                {chainItemMeta.map((item) => {
                  const isOn = inventoryChainFilters[item.key];
                  const label = item.label;
                  const disabled = !item.hasAddress;
                  return (
                    <TooltipHint
                      key={item.key}
                      side="bottom"
                      sideOffset={6}
                      contentClassName="px-2.5 py-1.5 text-xs font-medium"
                      content={
                        disabled
                          ? `${label} — no wallet configured`
                          : isOn
                            ? `${label} — visible`
                            : `${label} — hidden`
                      }
                    >
                      <button
                        type="button"
                        data-testid={`inventory-chain-toggle-${item.key}`}
                        onClick={
                          disabled
                            ? () => setWalletRpcOpen(true)
                            : () => handleInventoryChainToggle(item.key)
                        }
                        aria-pressed={disabled ? undefined : isOn}
                        aria-label={
                          disabled
                            ? label
                            : isOn
                              ? `${label} — shown (click to hide)`
                              : `${label} — hidden (click to show)`
                        }
                        aria-disabled={disabled}
                        className={`flex aspect-square items-center justify-center rounded-2xl border transition-colors ${
                          disabled
                            ? "cursor-pointer border-border/20 bg-bg/10 text-muted opacity-40 hover:opacity-60 hover:border-accent/30"
                            : isOn
                              ? "border-accent/30 bg-accent/14 text-txt-strong"
                              : "border-border/40 bg-bg/20 text-muted opacity-45 hover:border-border/60 hover:text-txt hover:opacity-70"
                        }`}
                      >
                        <ChainIcon chain={item.key} size="lg" />
                      </button>
                    </TooltipHint>
                  );
                })}
              </div>
            </div>
          </div>
        </SidebarPanel>
      </SidebarScrollRegion>
    </Sidebar>
  );

  const stewardConnected = stewardStatus?.connected === true;
  const stewardEvmAddrPresent = Boolean(
    stewardConnected &&
      (stewardStatus?.walletAddresses?.evm || stewardStatus?.evmAddress),
  );
  const stewardSolAddrPresent = Boolean(
    stewardConnected && stewardStatus?.walletAddresses?.solana,
  );
  const hasAnyAddress = Boolean(
    evmAddr || solAddr || stewardEvmAddrPresent || stewardSolAddrPresent,
  );
  const walletSubTabItems = [
    { value: "balances" as const, label: "Balances" },
    { value: "transactions" as const, label: "Transactions" },
    {
      value: "approvals" as const,
      label: "Approvals",
      badge:
        pendingApprovalCount > 0 ? (
          <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-danger px-1 text-3xs font-bold text-white">
            {pendingApprovalCount > 99 ? "99+" : pendingApprovalCount}
          </span>
        ) : undefined,
    },
  ];
  const walletSubTabControls = (
    <div className="mb-4 flex justify-end">
      <SegmentedControl
        value={walletSubTab}
        onValueChange={(value: WalletSubTab) => setWalletSubTab(value)}
        items={walletSubTabItems}
      />
    </div>
  );

  // ════════════════════════════════════════════════════════════════════
  // Render
  // ════════════════════════════════════════════════════════════════════

  // ── Standalone states (no two-panel layout) ─────────────────────
  if (walletLoading && !walletBalances) {
    return (
      <PageLayout
        sidebar={walletSidebar}
        contentInnerClassName="mx-auto w-full max-w-[76rem]"
        footer={<WidgetHost slot="wallet" className="py-3" />}
      >
        {walletSubTabControls}
        <PagePanel.Loading
          variant="workspace"
          heading={t("wallet.loadingBalances")}
        />
      </PageLayout>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <PageLayout
        sidebar={walletSidebar}
        contentInnerClassName="mx-auto w-full max-w-[76rem]"
        footer={<WidgetHost slot="wallet" className="py-3" />}
      >
        {walletSubTabControls}
        <div className="grid gap-3">
          {walletError ? (
            <PagePanel.Notice tone="danger">{walletError}</PagePanel.Notice>
          ) : null}

          {inlineError?.message ? (
            <PagePanel.Notice
              tone="danger"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-full border-danger/35 px-3 text-xs-tight text-danger shadow-none hover:bg-danger/10"
                  onClick={() => void loadBalances()}
                  title={inlineError.retryTitle ?? t("common.retry")}
                >
                  {t("common.retry")}
                </Button>
              }
            >
              {inlineError.message}
            </PagePanel.Notice>
          ) : null}

          {headerWarning ? (
            <PagePanel.Notice
              tone="accent"
              actions={
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs-tight font-medium text-accent"
                  onClick={goToRpcSettings}
                >
                  {headerWarning.actionLabel}
                </Button>
              }
            >
              <div className="font-semibold text-txt-strong">
                {headerWarning.title}
              </div>
              <div className="mt-1 text-muted">{headerWarning.body}</div>
            </PagePanel.Notice>
          ) : null}

          {/* Wallet setup card — shown when no wallet is connected */}
          {!hasAnyAddress && (
            <PagePanel variant="workspace">
              <div className="flex flex-col items-center gap-4 py-8">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-accent/25 bg-accent/10 text-accent">
                  <Wallet className="h-6 w-6" />
                </div>
                <div className="text-center">
                  <h3 className="text-sm font-semibold text-txt">
                    {t("wallet.setup.title", {
                      defaultValue: "Connect your wallet",
                    })}
                  </h3>
                  <p className="mt-1 max-w-sm text-xs text-muted">
                    {t("wallet.setup.description", {
                      defaultValue:
                        "Connect via Eliza Cloud or configure wallet keys directly to start trading.",
                    })}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  {elizaCloudConnected ? (
                    <Button
                      variant="default"
                      size="sm"
                      className="rounded-full px-5"
                      onClick={goToRpcSettings}
                    >
                      {t("wallet.setup.importFromCloud", {
                        defaultValue: "Import from Eliza Cloud",
                      })}
                    </Button>
                  ) : null}
                  {/* Vincent connection moved to Apps → Vincent */}
                  <Button
                    variant="outline"
                    size="sm"
                    className="rounded-full px-5"
                    onClick={goToRpcSettings}
                  >
                    <Settings className="mr-1.5 h-3.5 w-3.5" />
                    {t("wallet.setup.configureRpc", {
                      defaultValue: "Configure RPC",
                    })}
                  </Button>
                </div>
              </div>
            </PagePanel>
          )}

          {singleChainFocus === "bsc" ? (
            <TradePanel
              tradeReady={evmAddr ? tradeReady : false}
              bnbBalance={bnbBalance}
              onAddToken={handleAddToken}
              getBscTradePreflight={getBscTradePreflight}
              getBscTradeQuote={getBscTradeQuote}
              executeBscTrade={executeBscTrade}
              getBscTradeTxStatus={getBscTradeTxStatus}
              stewardConnected={stewardConnected}
            />
          ) : null}
        </div>

        <div className="mt-4">
          {walletSubTab === "balances" ? (
            <PagePanel variant="workspace">
              {inventoryView === "tokens" ? (
                <TokensTable
                  t={t}
                  walletLoading={walletLoading}
                  walletBalances={walletBalances}
                  visibleRows={filteredVisibleRows}
                  visibleChainErrors={visibleChainErrors}
                  showChainColumn={singleChainFocus === null}
                  handleUntrackToken={handleUntrackToken}
                />
              ) : (
                <NftGrid
                  t={t}
                  walletNftsLoading={walletNftsLoading}
                  walletNfts={walletNfts}
                  allNfts={filteredNfts}
                />
              )}
            </PagePanel>
          ) : (
            <PagePanel variant="workspace">
              {!stewardConnected ? (
                <PagePanel.Empty
                  variant="workspace"
                  title={
                    walletSubTab === "approvals"
                      ? "No pending approvals"
                      : "No transactions yet"
                  }
                />
              ) : walletSubTab === "approvals" ? (
                <ApprovalQueue
                  embedded
                  getStewardPending={getStewardPending}
                  approveStewardTx={approveStewardTx}
                  rejectStewardTx={rejectStewardTx}
                  copyToClipboard={copyToClipboard}
                  setActionNotice={setActionNotice}
                  onPendingCountChange={handlePendingCountChange}
                />
              ) : (
                <TransactionHistory
                  embedded
                  getStewardHistory={getStewardHistory}
                  copyToClipboard={copyToClipboard}
                  setActionNotice={setActionNotice}
                />
              )}
            </PagePanel>
          )}
        </div>
      </PageLayout>

      {/* ── Wallet & RPC popup ── */}
      <Dialog open={walletRpcOpen} onOpenChange={setWalletRpcOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {stewardConnected
                ? t("settings.sections.wallet.label", {
                    defaultValue: "Wallet",
                  })
                : t("settings.sections.walletrpc.label", {
                    defaultValue: "Wallet & RPC",
                  })}
            </DialogTitle>
          </DialogHeader>
          {stewardConnected && stewardStatus ? (
            <StewardWalletInfoPopup
              stewardStatus={stewardStatus}
              onOpenPolicies={() => {
                setWalletRpcOpen(false);
                setWalletPoliciesOpen(true);
              }}
            />
          ) : (
            <ConfigPageView embedded />
          )}
        </DialogContent>
      </Dialog>

      {/* ── Wallet Policies popup ── */}
      <Dialog open={walletPoliciesOpen} onOpenChange={setWalletPoliciesOpen}>
        <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {t("settings.sections.walletpolicies.label", {
                defaultValue: "Wallet Policies",
              })}
            </DialogTitle>
          </DialogHeader>
          <PolicyControlsView />
        </DialogContent>
      </Dialog>
    </div>
  );
}
