/**
 * Wallet / Inventory / Registry / Drop / Whitelist state — extracted from AppContext.
 *
 * Manages:
 * - Wallet addresses, config, balances, NFTs, export flow
 * - Inventory view preferences (sort, filter, chain toggles)
 * - ERC-8004 on-chain registry (register, sync, status)
 * - Drop / mint state and actions
 * - Whitelist status
 *
 * Cross-domain dependencies accepted as params:
 * - `setActionNotice` — from useLifecycleState, used by handleWalletApiKeySave
 * - `agentName`       — from agentStatus?.agentName, used by registry/mint
 * - `characterName`   — from characterDraft?.name, used by registry/mint
 * - `promptModal`     — from AppContext's usePrompt(), used by handleExportKeys
 * - `confirmAction`   — confirmDesktopAction utility, used by handleExportKeys
 */

import { useCallback, useRef, useState } from "react";
import {
  type DropStatus,
  type MintResult,
  type RegistryStatus,
  type WalletAddresses,
  type WalletBalancesResponse,
  type WalletConfigStatus,
  type WalletConfigUpdateRequest,
  type WalletExportResult,
  type WalletNftsResponse,
  type WhitelistStatus,
  client,
} from "../api";
import type { PromptOptions } from "@elizaos/app-core";
import { confirmDesktopAction } from "../utils";
import {
  loadBrowserEnabled,
  loadWalletEnabled,
  saveBrowserEnabled,
  saveWalletEnabled,
} from "./persistence";
import type { InventoryChainFilters } from "./types";

// ── Types ──────────────────────────────────────────────────────────────

interface WalletStateParams {
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;
  /** Prompt modal function from AppContext's usePrompt() instance */
  promptModal: (opts: PromptOptions) => Promise<string | null>;
  /** Current agent name (from agentStatus?.agentName) */
  agentName: string | undefined;
  /** Current character draft name (from characterDraft?.name) */
  characterName: string | undefined;
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useWalletState({
  setActionNotice,
  promptModal,
  agentName,
  characterName,
}: WalletStateParams) {
  // ── Feature toggles ────────────────────────────────────────────────
  const [walletEnabled, setWalletEnabledRaw] = useState(loadWalletEnabled);
  const setWalletEnabled = useCallback((v: boolean) => {
    setWalletEnabledRaw(v);
    saveWalletEnabled(v);
  }, []);

  const [browserEnabled, setBrowserEnabledRaw] = useState(loadBrowserEnabled);
  const setBrowserEnabled = useCallback((v: boolean) => {
    setBrowserEnabledRaw(v);
    saveBrowserEnabled(v);
  }, []);

  // ── Wallet / Inventory ─────────────────────────────────────────────
  const [walletAddresses, setWalletAddresses] =
    useState<WalletAddresses | null>(null);
  const [walletConfig, setWalletConfig] = useState<WalletConfigStatus | null>(
    null,
  );
  const [walletBalances, setWalletBalances] =
    useState<WalletBalancesResponse | null>(null);
  const [walletNfts, setWalletNfts] = useState<WalletNftsResponse | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletNftsLoading, setWalletNftsLoading] = useState(false);
  const [inventoryView, setInventoryView] = useState<"tokens" | "nfts">(
    "tokens",
  );
  const [walletExportData, setWalletExportData] =
    useState<WalletExportResult | null>(null);
  const [walletExportVisible, setWalletExportVisible] = useState(false);
  const [walletApiKeySaving, setWalletApiKeySaving] = useState(false);
  const [inventorySort, setInventorySort] = useState<
    "chain" | "symbol" | "value"
  >("value");
  const [inventorySortDirection, setInventorySortDirection] = useState<
    "asc" | "desc"
  >("desc");
  const [inventoryChainFilters, setInventoryChainFilters] =
    useState<InventoryChainFilters>({
      ethereum: true,
      base: true,
      bsc: true,
      avax: true,
      solana: true,
    });
  const [walletError, setWalletError] = useState<string | null>(null);

  // ── ERC-8004 Registry ──────────────────────────────────────────────
  const [registryStatus, setRegistryStatus] = useState<RegistryStatus | null>(
    null,
  );
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryRegistering, setRegistryRegistering] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);

  // ── Drop / Mint ────────────────────────────────────────────────────
  const [dropStatus, setDropStatus] = useState<DropStatus | null>(null);
  const [dropLoading, setDropLoading] = useState(false);
  const [mintInProgress, setMintInProgress] = useState(false);
  const [mintResult, setMintResult] = useState<MintResult | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  const [mintShiny, setMintShiny] = useState(false);

  // ── Whitelist ──────────────────────────────────────────────────────
  const [whitelistStatus, setWhitelistStatus] =
    useState<WhitelistStatus | null>(null);
  const [whitelistLoading, setWhitelistLoading] = useState(false);

  // ── Synchronous lock to prevent duplicate save clicks ──────────────
  const walletApiKeySavingRef = useRef(false);
  const walletExportTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  // ── Wallet callbacks ───────────────────────────────────────────────

  const loadWalletConfig = useCallback(async () => {
    try {
      const cfg = await client.getWalletConfig();
      setWalletConfig(cfg);
      setWalletAddresses({
        evmAddress: cfg.evmAddress,
        solanaAddress: cfg.solanaAddress,
      });
      setWalletError(null);
    } catch (err) {
      setWalletError(
        `Failed to load wallet config: ${err instanceof Error ? err.message : "network error"}`,
      );
    }
  }, []);

  const loadBalances = useCallback(async () => {
    setWalletLoading(true);
    setWalletError(null);
    try {
      const b = await client.getWalletBalances();
      setWalletBalances(b);
    } catch (err) {
      setWalletError(
        `Failed to fetch balances: ${err instanceof Error ? err.message : "network error"}`,
      );
    }
    setWalletLoading(false);
  }, []);

  const loadNfts = useCallback(async () => {
    setWalletNftsLoading(true);
    setWalletError(null);
    try {
      const n = await client.getWalletNfts();
      setWalletNfts(n);
    } catch (err) {
      setWalletError(
        `Failed to fetch NFTs: ${err instanceof Error ? err.message : "network error"}`,
      );
    }
    setWalletNftsLoading(false);
  }, []);

  const handleWalletApiKeySave = useCallback(
    async (config: WalletConfigUpdateRequest) => {
      if (
        Object.keys(config.credentials ?? {}).length === 0 &&
        Object.keys(config.selections ?? {}).length === 0
      ) {
        return;
      }
      if (walletApiKeySavingRef.current || walletApiKeySaving) return;
      walletApiKeySavingRef.current = true;
      setWalletApiKeySaving(true);
      setWalletError(null);
      try {
        await client.updateWalletConfig(config);
        await loadWalletConfig();
        await loadBalances();
        setActionNotice(
          "Wallet RPC settings saved. Restart required to apply.",
          "success",
        );
      } catch (err) {
        setWalletError(
          `Failed to save API keys: ${err instanceof Error ? err.message : "network error"}`,
        );
      } finally {
        walletApiKeySavingRef.current = false;
        setWalletApiKeySaving(false);
      }
    },
    [walletApiKeySaving, loadWalletConfig, loadBalances, setActionNotice],
  );

  const handleExportKeys = useCallback(async () => {
    if (walletExportVisible) {
      if (walletExportTimerRef.current) {
        clearTimeout(walletExportTimerRef.current);
        walletExportTimerRef.current = null;
      }
      setWalletExportVisible(false);
      setWalletExportData(null);
      return;
    }
    const confirmed = await confirmDesktopAction({
      title: "Reveal Private Keys",
      message: "This will reveal your private keys.",
      detail:
        "NEVER share your private keys with anyone. Anyone with your private keys can steal all funds in your wallets.",
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
      type: "warning",
    });
    if (!confirmed) return;
    const exportToken = await promptModal({
      title: "Wallet Export Token",
      message: "Enter your wallet export token (ELIZA_WALLET_EXPORT_TOKEN):",
      placeholder: "ELIZA_WALLET_EXPORT_TOKEN",
      confirmLabel: "Export",
      cancelLabel: "Cancel",
    });
    if (exportToken === null) return;
    if (!exportToken.trim()) {
      setWalletError("Wallet export token is required.");
      return;
    }
    try {
      const data = await client.exportWalletKeys(exportToken.trim());
      setWalletExportData(data);
      setWalletExportVisible(true);
      if (walletExportTimerRef.current) {
        clearTimeout(walletExportTimerRef.current);
      }
      walletExportTimerRef.current = setTimeout(() => {
        walletExportTimerRef.current = null;
        setWalletExportVisible(false);
        setWalletExportData(null);
      }, 60_000);
    } catch (err) {
      setWalletError(
        `Failed to export keys: ${err instanceof Error ? err.message : "network error"}`,
      );
    }
  }, [promptModal, walletExportVisible]);

  // ── Registry callbacks ─────────────────────────────────────────────

  const loadRegistryStatus = useCallback(async () => {
    setRegistryLoading(true);
    setRegistryError(null);
    try {
      const status = await client.getRegistryStatus();
      setRegistryStatus(status);
    } catch (err) {
      setRegistryError(
        err instanceof Error ? err.message : "Failed to load registry status",
      );
    } finally {
      setRegistryLoading(false);
    }
  }, []);

  const registerOnChain = useCallback(async () => {
    setRegistryRegistering(true);
    setRegistryError(null);
    try {
      await client.registerAgent({
        name: characterName || agentName,
      });
      await loadRegistryStatus();
    } catch (err) {
      setRegistryError(
        err instanceof Error ? err.message : "Registration failed",
      );
    } finally {
      setRegistryRegistering(false);
    }
  }, [characterName, agentName, loadRegistryStatus]);

  const syncRegistryProfile = useCallback(async () => {
    setRegistryRegistering(true);
    setRegistryError(null);
    try {
      await client.syncRegistryProfile({
        name: characterName || agentName,
      });
      await loadRegistryStatus();
    } catch (err) {
      setRegistryError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setRegistryRegistering(false);
    }
  }, [characterName, agentName, loadRegistryStatus]);

  // ── Drop / Mint callbacks ──────────────────────────────────────────

  const loadDropStatus = useCallback(async () => {
    setDropLoading(true);
    try {
      const status = await client.getDropStatus();
      setDropStatus(status);
    } catch {
      // Non-critical -- drop may not be configured
    } finally {
      setDropLoading(false);
    }
  }, []);

  const mintFromDrop = useCallback(
    async (shiny: boolean) => {
      setMintInProgress(true);
      setMintShiny(shiny);
      setMintError(null);
      setMintResult(null);
      try {
        const result = await client.mintAgent({
          name: characterName || agentName,
          shiny,
        });
        setMintResult(result);
        await loadRegistryStatus();
        await loadDropStatus();
      } catch (err) {
        setMintError(err instanceof Error ? err.message : "Mint failed");
      } finally {
        setMintInProgress(false);
        setMintShiny(false);
      }
    },
    [characterName, agentName, loadRegistryStatus, loadDropStatus],
  );

  // ── Whitelist callback ─────────────────────────────────────────────

  const loadWhitelistStatus = useCallback(async () => {
    setWhitelistLoading(true);
    try {
      const status = await client.getWhitelistStatus();
      setWhitelistStatus(status);
    } catch {
      // Non-critical
    } finally {
      setWhitelistLoading(false);
    }
  }, []);

  // ── Return ─────────────────────────────────────────────────────────

  return {
    state: {
      browserEnabled,
      walletEnabled,
      walletAddresses,
      walletConfig,
      walletBalances,
      walletNfts,
      walletLoading,
      walletNftsLoading,
      inventoryView,
      walletExportData,
      walletExportVisible,
      walletApiKeySaving,
      inventorySort,
      inventorySortDirection,
      inventoryChainFilters,
      walletError,
      registryStatus,
      registryLoading,
      registryRegistering,
      registryError,
      dropStatus,
      dropLoading,
      mintInProgress,
      mintResult,
      mintError,
      mintShiny,
      whitelistStatus,
      whitelistLoading,
    },
    // Raw setters needed by AppContext for UI binding
    setBrowserEnabled,
    setWalletEnabled,
    setWalletAddresses,
    setInventoryView,
    setInventorySort,
    setInventorySortDirection,
    setInventoryChainFilters,
    setWalletError,
    setRegistryError,
    setMintResult,
    setMintError,
    // Callbacks
    loadWalletConfig,
    loadBalances,
    loadNfts,
    handleWalletApiKeySave,
    handleExportKeys,
    loadRegistryStatus,
    registerOnChain,
    syncRegistryProfile,
    loadDropStatus,
    mintFromDrop,
    loadWhitelistStatus,
  };
}
