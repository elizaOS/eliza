/**
 * Wallet / Inventory / Registry / Drop / Whitelist state, one of the domain hooks AppContext composes.
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

import { logger } from "@elizaos/logger";
import type {
  WalletAddresses,
  WalletBalancesResponse,
  WalletChainKind,
  WalletConfigStatus,
  WalletConfigUpdateRequest,
  WalletEntry,
  WalletNftsResponse,
  WalletPrimaryMap,
  WalletSource,
} from "@elizaos/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  client,
  type DropStatus,
  type MintResult,
  type RegistryStatus,
  type WalletExportResult,
  type WhitelistStatus,
} from "../api";
import { isApiError } from "../api/client-types-core";
import type { PromptOptions } from "../components/ui/confirm-dialog";
import {
  getActiveAgentAuthority,
  useActiveAgentAuthority,
} from "../hooks/useActiveAgentAuthority";
import { confirmDesktopAction } from "../utils/desktop-dialogs";
import {
  loadBrowserEnabled,
  loadComputerUseEnabled,
  loadWalletEnabled,
  saveBrowserEnabled,
  saveComputerUseEnabled,
  saveWalletEnabled,
} from "./persistence";
import type { InventoryChainFilters, WalletResourceStatus } from "./types";

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
  /** Hydrate capability flags from the running backend config. */
  hydrateServerConfig?: boolean;
}

interface WalletAuthorityToken {
  authority: string;
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useWalletState({
  setActionNotice,
  promptModal,
  agentName,
  characterName,
  hydrateServerConfig = true,
}: WalletStateParams) {
  const authority = useActiveAgentAuthority();
  // Replacing this token during render gives async continuations an immediate
  // authority boundary. The synchronous getter also covers the narrow window
  // between a client repoint and React committing the resulting render.
  const authorityTokenRef = useRef<WalletAuthorityToken>({ authority });
  const walletStateAuthorityRef = useRef(authority);
  if (authorityTokenRef.current.authority !== authority) {
    authorityTokenRef.current = { authority };
  }
  const isCurrentAuthority = useCallback((token: WalletAuthorityToken) => {
    return (
      authorityTokenRef.current === token &&
      getActiveAgentAuthority() === token.authority
    );
  }, []);

  // ── Feature toggles ────────────────────────────────────────────────
  // A capability toggle is a write that matters: if the server-side config
  // update fails silently, the running agent's capabilities diverge from what
  // the settings UI shows. Surface the failure instead of swallowing it.
  const syncCapability = useCallback(
    (name: "wallet" | "browser" | "computerUse", v: boolean) => {
      const requestAuthority = authorityTokenRef.current;
      if (!isCurrentAuthority(requestAuthority)) return;
      void client
        .updateConfig({ ui: { capabilities: { [name]: v } } })
        .catch((err: unknown) => {
          if (!isCurrentAuthority(requestAuthority)) return;
          logger.error(
            { err, capability: name, value: v },
            "[useWalletState] capability sync to server failed",
          );
          setActionNotice(
            `Failed to sync ${name} setting to the agent — it may revert on reload`,
            "error",
          );
        });
    },
    [isCurrentAuthority, setActionNotice],
  );

  const [walletEnabled, setWalletEnabledRaw] = useState(loadWalletEnabled);
  const setWalletEnabled = useCallback(
    (v: boolean) => {
      setWalletEnabledRaw(v);
      saveWalletEnabled(v);
      syncCapability("wallet", v);
    },
    [syncCapability],
  );

  const [browserEnabled, setBrowserEnabledRaw] = useState(loadBrowserEnabled);
  const setBrowserEnabled = useCallback(
    (v: boolean) => {
      setBrowserEnabledRaw(v);
      saveBrowserEnabled(v);
      syncCapability("browser", v);
    },
    [syncCapability],
  );

  const [computerUseEnabled, setComputerUseEnabledRaw] = useState(
    loadComputerUseEnabled,
  );
  const setComputerUseEnabled = useCallback(
    (v: boolean) => {
      setComputerUseEnabledRaw(v);
      saveComputerUseEnabled(v);
      syncCapability("computerUse", v);
    },
    [syncCapability],
  );

  // ── Hydrate capability flags from server config on mount ──────────
  // Server config (written by TOGGLE_CAPABILITY agent action) wins on
  // first load; localStorage remains a fallback for offline / stale.
  useEffect(() => {
    if (!hydrateServerConfig) return;
    const requestAuthority = authorityTokenRef.current;
    if (requestAuthority.authority !== authority) return;
    let cancelled = false;
    void client
      .getConfig()
      .then((cfg) => {
        if (cancelled || !isCurrentAuthority(requestAuthority)) return;
        const caps = cfg.ui?.capabilities;
        if (!caps) return;
        if (typeof caps.wallet === "boolean") {
          setWalletEnabledRaw(caps.wallet);
          saveWalletEnabled(caps.wallet);
        }
        if (typeof caps.browser === "boolean") {
          setBrowserEnabledRaw(caps.browser);
          saveBrowserEnabled(caps.browser);
        }
        if (typeof caps.computerUse === "boolean") {
          setComputerUseEnabledRaw(caps.computerUse);
          saveComputerUseEnabled(caps.computerUse);
        }
      })
      // error-policy:J4 capability flags keep their localStorage values when
      // the server config is unreachable; log so a broken config endpoint is
      // still observable.
      .catch((err: unknown) => {
        if (!isCurrentAuthority(requestAuthority)) return;
        logger.warn(
          { err },
          "[useWalletState] capability hydration from server config failed; keeping local values",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [authority, hydrateServerConfig, isCurrentAuthority]);

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
  const [walletConfigStatus, setWalletConfigStatus] =
    useState<WalletResourceStatus>("idle");
  const [walletConfigError, setWalletConfigError] = useState<string | null>(
    null,
  );
  const [walletBalancesStatus, setWalletBalancesStatus] =
    useState<WalletResourceStatus>("idle");
  const [walletBalancesError, setWalletBalancesError] = useState<string | null>(
    null,
  );
  const [walletNftsStatus, setWalletNftsStatus] =
    useState<WalletResourceStatus>("idle");
  const [walletNftsError, setWalletNftsError] = useState<string | null>(null);
  const [inventoryView, setInventoryView] = useState<"tokens" | "nfts">(
    "tokens",
  );
  const [walletExportData, setWalletExportData] =
    useState<WalletExportResult | null>(null);
  const [walletExportVisible, setWalletExportVisible] = useState(false);
  const [walletApiKeySaving, setWalletApiKeySaving] = useState(false);
  const [wallets, setWallets] = useState<WalletEntry[]>([]);
  const [walletPrimary, setWalletPrimaryMap] =
    useState<WalletPrimaryMap | null>(null);
  const [walletPrimaryRestarting] = useState<
    Partial<Record<WalletChainKind, boolean>>
  >({});
  const [walletPrimaryPending, setWalletPrimaryPending] = useState<
    Partial<Record<WalletChainKind, boolean>>
  >({});
  const [cloudRefreshing, setCloudRefreshing] = useState(false);
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
  const walletConfigRequestRef = useRef(0);
  const walletBalancesRequestRef = useRef(0);
  const walletNftsRequestRef = useRef(0);

  useEffect(() => {
    if (walletStateAuthorityRef.current === authority) return;
    walletStateAuthorityRef.current = authority;

    // Agent-owned wallet material is fail-closed across a repoint. Clear every
    // public/config/balance surface before the new authority's loaders settle;
    // request-token checks below prevent old continuations from repopulating it.
    setWalletAddresses(null);
    setWalletConfig(null);
    setWalletBalances(null);
    setWalletNfts(null);
    setWalletLoading(false);
    setWalletNftsLoading(false);
    setWalletConfigStatus("idle");
    setWalletConfigError(null);
    setWalletBalancesStatus("idle");
    setWalletBalancesError(null);
    setWalletNftsStatus("idle");
    setWalletNftsError(null);
    setWalletExportData(null);
    setWalletExportVisible(false);
    setWalletApiKeySaving(false);
    walletApiKeySavingRef.current = false;
    if (walletExportTimerRef.current) {
      clearTimeout(walletExportTimerRef.current);
      walletExportTimerRef.current = null;
    }
    setWallets([]);
    setWalletPrimaryMap(null);
    setWalletPrimaryPending({});
    setCloudRefreshing(false);
    setWalletError(null);

    setRegistryStatus(null);
    setRegistryLoading(false);
    setRegistryRegistering(false);
    setRegistryError(null);
    setDropStatus(null);
    setDropLoading(false);
    setMintInProgress(false);
    setMintResult(null);
    setMintError(null);
    setMintShiny(false);
    setWhitelistStatus(null);
    setWhitelistLoading(false);
  }, [authority]);

  const applyWalletConfig = useCallback((cfg: WalletConfigStatus) => {
    setWalletConfig(cfg);
    setWalletAddresses({
      evmAddress: cfg.evmAddress,
      solanaAddress: cfg.solanaAddress,
    });
    setWallets(Array.isArray(cfg.wallets) ? cfg.wallets : []);
    setWalletPrimaryMap(cfg.primary ?? null);
  }, []);

  const fetchWalletConfig = useCallback(async () => {
    const requestAuthority = authorityTokenRef.current;
    if (!isCurrentAuthority(requestAuthority)) {
      throw new Error("Wallet authority changed");
    }
    const requestId = walletConfigRequestRef.current + 1;
    walletConfigRequestRef.current = requestId;
    setWalletConfigStatus("loading");
    setWalletConfigError(null);

    try {
      const cfg = await client.getWalletConfig();
      if (
        isCurrentAuthority(requestAuthority) &&
        walletConfigRequestRef.current === requestId
      ) {
        applyWalletConfig(cfg);
        setWalletConfigError(null);
        setWalletConfigStatus("ready");
      }
      return cfg;
    } catch (err) {
      // error-policy:J4 config failure is scoped to config and preserves any
      // previously rendered wallet data. Only the newest request may publish
      // its result, so an older poll cannot undo a newer save or refresh.
      if (
        isCurrentAuthority(requestAuthority) &&
        walletConfigRequestRef.current === requestId
      ) {
        setWalletConfigError(
          `Failed to load wallet config: ${err instanceof Error ? err.message : "network error"}`,
        );
        setWalletConfigStatus("error");
      }
      throw err;
    }
  }, [applyWalletConfig, isCurrentAuthority]);

  const hasWalletSource = useCallback(
    (
      config: WalletConfigStatus | null | undefined,
      chain: WalletChainKind,
      source: WalletSource,
    ) =>
      (config?.wallets ?? []).some(
        (wallet: WalletEntry) =>
          wallet.chain === chain &&
          wallet.source === source &&
          typeof wallet.address === "string" &&
          wallet.address.trim().length > 0,
      ),
    [],
  );

  const normalizeCloudWalletNotice = useCallback((warning: string) => {
    const detail = warning.replace(
      /^Cloud (evm|solana) wallet import failed:\s*/i,
      "",
    );
    if (/Invalid Solana address \(base58, 32–44 chars\)/i.test(detail)) {
      return "the connected Eliza Cloud backend is still using the legacy Solana wallet contract";
    }
    return detail;
  }, []);

  const summarizeCloudWalletImport = useCallback(
    (
      config: WalletConfigStatus | null | undefined,
      warnings: string[] | undefined,
    ): { text: string; tone: "success" | "info" } => {
      const evmConnected = hasWalletSource(config, "evm", "cloud");
      const solanaConnected = hasWalletSource(config, "solana", "cloud");

      if (evmConnected && solanaConnected) {
        return { text: "Cloud wallets connected.", tone: "success" };
      }

      const solanaWarning = warnings?.find((warning) =>
        /Cloud solana wallet import failed:/i.test(warning),
      );
      if (evmConnected && solanaWarning) {
        return {
          text: `Ethereum + Base cloud wallet connected. Solana cloud wallet is unavailable because ${normalizeCloudWalletNotice(solanaWarning)}.`,
          tone: "info",
        };
      }

      const evmWarning = warnings?.find((warning) =>
        /Cloud evm wallet import failed:/i.test(warning),
      );
      if (solanaConnected && evmWarning) {
        return {
          text: `Solana cloud wallet connected. Ethereum + Base cloud wallet is unavailable because ${normalizeCloudWalletNotice(evmWarning)}.`,
          tone: "info",
        };
      }

      return { text: "Cloud wallet import queued.", tone: "success" };
    },
    [hasWalletSource, normalizeCloudWalletNotice],
  );

  // ── Wallet callbacks ───────────────────────────────────────────────

  const loadWalletConfig = useCallback(async () => {
    try {
      await fetchWalletConfig();
    } catch {
      // fetchWalletConfig owns the typed lifecycle; public loads remain
      // fire-and-forget safe for effects and polling callers.
    }
  }, [fetchWalletConfig]);

  const loadBalances = useCallback(async () => {
    const requestAuthority = authorityTokenRef.current;
    if (!isCurrentAuthority(requestAuthority)) return;
    const requestId = walletBalancesRequestRef.current + 1;
    walletBalancesRequestRef.current = requestId;
    setWalletLoading(true);
    setWalletBalancesStatus("loading");
    setWalletBalancesError(null);
    try {
      const b = await client.getWalletBalances();
      if (
        isCurrentAuthority(requestAuthority) &&
        walletBalancesRequestRef.current === requestId
      ) {
        setWalletBalances(b);
        setWalletBalancesStatus("ready");
      }
    } catch (err) {
      // error-policy:J4 balances own their error lifecycle. A later NFT/config
      // success must never erase this failure or turn null data into $0.
      if (
        isCurrentAuthority(requestAuthority) &&
        walletBalancesRequestRef.current === requestId
      ) {
        setWalletBalancesError(
          `Failed to fetch balances: ${err instanceof Error ? err.message : "network error"}`,
        );
        setWalletBalancesStatus("error");
      }
    } finally {
      if (
        isCurrentAuthority(requestAuthority) &&
        walletBalancesRequestRef.current === requestId
      ) {
        setWalletLoading(false);
      }
    }
  }, [isCurrentAuthority]);

  const loadNfts = useCallback(async () => {
    const requestAuthority = authorityTokenRef.current;
    if (!isCurrentAuthority(requestAuthority)) return;
    const requestId = walletNftsRequestRef.current + 1;
    walletNftsRequestRef.current = requestId;
    setWalletNftsLoading(true);
    setWalletNftsStatus("loading");
    setWalletNftsError(null);
    try {
      const n = await client.getWalletNfts();
      if (
        isCurrentAuthority(requestAuthority) &&
        walletNftsRequestRef.current === requestId
      ) {
        setWalletNfts(n);
        setWalletNftsStatus("ready");
      }
    } catch (err) {
      // error-policy:J4 an absent optional NFT capability is not evidence of an
      // empty wallet. Mark it unavailable (and stop polling it) without
      // contaminating balances/config; transient failures remain scoped errors.
      if (
        isCurrentAuthority(requestAuthority) &&
        walletNftsRequestRef.current === requestId
      ) {
        const unavailable =
          isApiError(err) &&
          (err.status === 404 ||
            err.status === 501 ||
            err.code === "wallet_nfts_unavailable");
        if (unavailable) {
          setWalletNfts(null);
          setWalletNftsError(null);
          setWalletNftsStatus("unavailable");
        } else {
          setWalletNftsError(
            `Failed to fetch NFTs: ${err instanceof Error ? err.message : "network error"}`,
          );
          setWalletNftsStatus("error");
        }
      }
    } finally {
      if (
        isCurrentAuthority(requestAuthority) &&
        walletNftsRequestRef.current === requestId
      ) {
        setWalletNftsLoading(false);
      }
    }
  }, [isCurrentAuthority]);

  const handleWalletApiKeySave = useCallback(
    async (config: WalletConfigUpdateRequest) => {
      const requestAuthority = authorityTokenRef.current;
      if (!isCurrentAuthority(requestAuthority)) return false;
      if (
        Object.keys(config.credentials ?? {}).length === 0 &&
        Object.keys(config.selections ?? {}).length === 0
      ) {
        return false;
      }
      if (walletApiKeySavingRef.current || walletApiKeySaving) return false;
      walletApiKeySavingRef.current = true;
      setWalletApiKeySaving(true);
      setWalletError(null);
      try {
        await client.updateWalletConfig(config);
        if (!isCurrentAuthority(requestAuthority)) return false;
        const selectedProviders = config.selections;
        const shouldImportCloudWallets =
          selectedProviders.evm === "eliza-cloud" &&
          selectedProviders.bsc === "eliza-cloud" &&
          selectedProviders.solana === "eliza-cloud";

        let walletConfigAfterSave: WalletConfigStatus | null | undefined;
        if (shouldImportCloudWallets) {
          setCloudRefreshing(true);
          try {
            const refreshResult = await client.refreshCloudWallets();
            if (!isCurrentAuthority(requestAuthority)) return false;
            walletConfigAfterSave = await fetchWalletConfig();
            if (!isCurrentAuthority(requestAuthority)) return false;
            const notice = summarizeCloudWalletImport(
              walletConfigAfterSave,
              refreshResult?.warnings,
            );
            setActionNotice(notice.text, notice.tone);
          } finally {
            if (isCurrentAuthority(requestAuthority)) {
              setCloudRefreshing(false);
            }
          }
        } else {
          walletConfigAfterSave = await fetchWalletConfig();
          if (!isCurrentAuthority(requestAuthority)) return false;
          setActionNotice(
            "Wallet RPC settings saved. Restart required to apply.",
            "success",
          );
        }
        await loadBalances();
        if (!isCurrentAuthority(requestAuthority)) return false;
        if (!walletConfigAfterSave) {
          await loadWalletConfig();
          if (!isCurrentAuthority(requestAuthority)) return false;
        }
        return true;
      } catch (err) {
        if (!isCurrentAuthority(requestAuthority)) return false;
        setWalletError(
          `Failed to save API keys: ${err instanceof Error ? err.message : "network error"}`,
        );
        return false;
      } finally {
        if (isCurrentAuthority(requestAuthority)) {
          walletApiKeySavingRef.current = false;
          setWalletApiKeySaving(false);
        }
      }
    },
    [
      walletApiKeySaving,
      fetchWalletConfig,
      isCurrentAuthority,
      loadBalances,
      loadWalletConfig,
      setActionNotice,
      summarizeCloudWalletImport,
    ],
  );

  const refreshCloudWallets = useCallback(async () => {
    const requestAuthority = authorityTokenRef.current;
    if (!isCurrentAuthority(requestAuthority)) return;
    setCloudRefreshing(true);
    setWalletError(null);
    try {
      const result = await client.refreshCloudWallets();
      if (!isCurrentAuthority(requestAuthority)) return;
      const nextConfig = await fetchWalletConfig();
      if (!isCurrentAuthority(requestAuthority)) return;
      const notice = summarizeCloudWalletImport(nextConfig, result?.warnings);
      setActionNotice(notice.text, notice.tone);
      await loadBalances();
    } catch (err) {
      if (!isCurrentAuthority(requestAuthority)) return;
      setWalletError(
        `Failed to refresh cloud wallets: ${err instanceof Error ? err.message : "network error"}`,
      );
    } finally {
      if (isCurrentAuthority(requestAuthority)) setCloudRefreshing(false);
    }
  }, [
    fetchWalletConfig,
    isCurrentAuthority,
    loadBalances,
    setActionNotice,
    summarizeCloudWalletImport,
  ]);

  const setWalletPrimary = useCallback(
    async (chain: WalletChainKind, source: WalletSource) => {
      const requestAuthority = authorityTokenRef.current;
      if (!isCurrentAuthority(requestAuthority)) return;
      setWalletPrimaryPending((prev) => ({ ...prev, [chain]: true }));
      setWalletError(null);
      try {
        let currentConfig =
          walletStateAuthorityRef.current === requestAuthority.authority
            ? walletConfig
            : null;
        if (!currentConfig) {
          currentConfig = await fetchWalletConfig();
          if (!isCurrentAuthority(requestAuthority)) return;
        }

        if (!hasWalletSource(currentConfig, chain, source)) {
          if (source === "local") {
            await client.generateWallet({ chain, source: "local" });
            if (!isCurrentAuthority(requestAuthority)) return;
          } else {
            setCloudRefreshing(true);
            try {
              await client.refreshCloudWallets();
            } finally {
              if (isCurrentAuthority(requestAuthority)) {
                setCloudRefreshing(false);
              }
            }
            if (!isCurrentAuthority(requestAuthority)) return;
          }
          currentConfig = await fetchWalletConfig();
          if (!isCurrentAuthority(requestAuthority)) return;
        }

        await client.setWalletPrimary({ chain, source });
        if (!isCurrentAuthority(requestAuthority)) return;
        await fetchWalletConfig();
        if (!isCurrentAuthority(requestAuthority)) return;
        await loadBalances();
      } catch (err) {
        if (!isCurrentAuthority(requestAuthority)) return;
        setWalletError(
          `Failed to switch wallet primary: ${err instanceof Error ? err.message : "network error"}`,
        );
      } finally {
        if (isCurrentAuthority(requestAuthority)) {
          setWalletPrimaryPending((prev) => {
            const next = { ...prev };
            delete next[chain];
            return next;
          });
        }
      }
    },
    [
      fetchWalletConfig,
      hasWalletSource,
      isCurrentAuthority,
      loadBalances,
      walletConfig,
    ],
  );

  const handleExportKeys = useCallback(async () => {
    const requestAuthority = authorityTokenRef.current;
    if (!isCurrentAuthority(requestAuthority)) return;
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
    if (!confirmed || !isCurrentAuthority(requestAuthority)) return;
    const exportToken = await promptModal({
      title: "Wallet Export Token",
      message: "Enter your wallet export token (ELIZA_WALLET_EXPORT_TOKEN):",
      placeholder: "ELIZA_WALLET_EXPORT_TOKEN",
      confirmLabel: "Export",
      cancelLabel: "Cancel",
    });
    if (exportToken === null || !isCurrentAuthority(requestAuthority)) return;
    if (!exportToken.trim()) {
      setWalletError("Wallet export token is required.");
      return;
    }
    try {
      const data = await client.exportWalletKeys(exportToken.trim());
      if (!isCurrentAuthority(requestAuthority)) return;
      setWalletExportData(data);
      setWalletExportVisible(true);
      if (walletExportTimerRef.current) {
        clearTimeout(walletExportTimerRef.current);
      }
      walletExportTimerRef.current = setTimeout(() => {
        if (!isCurrentAuthority(requestAuthority)) return;
        walletExportTimerRef.current = null;
        setWalletExportVisible(false);
        setWalletExportData(null);
      }, 60_000);
    } catch (err) {
      if (!isCurrentAuthority(requestAuthority)) return;
      setWalletError(
        `Failed to export keys: ${err instanceof Error ? err.message : "network error"}`,
      );
    }
  }, [isCurrentAuthority, promptModal, walletExportVisible]);

  // ── Registry callbacks ─────────────────────────────────────────────

  const loadRegistryStatus = useCallback(async () => {
    const requestAuthority = authorityTokenRef.current;
    if (!isCurrentAuthority(requestAuthority)) return;
    setRegistryLoading(true);
    setRegistryError(null);
    try {
      const status = await client.getRegistryStatus();
      if (isCurrentAuthority(requestAuthority)) setRegistryStatus(status);
    } catch (err) {
      if (!isCurrentAuthority(requestAuthority)) return;
      setRegistryError(
        err instanceof Error ? err.message : "Failed to load registry status",
      );
    } finally {
      if (isCurrentAuthority(requestAuthority)) setRegistryLoading(false);
    }
  }, [isCurrentAuthority]);

  const registerOnChain = useCallback(async () => {
    const requestAuthority = authorityTokenRef.current;
    if (!isCurrentAuthority(requestAuthority)) return;
    setRegistryRegistering(true);
    setRegistryError(null);
    try {
      await client.registerAgent({
        name: characterName || agentName,
      });
      if (!isCurrentAuthority(requestAuthority)) return;
      await loadRegistryStatus();
    } catch (err) {
      if (!isCurrentAuthority(requestAuthority)) return;
      setRegistryError(
        err instanceof Error ? err.message : "Registration failed",
      );
    } finally {
      if (isCurrentAuthority(requestAuthority)) {
        setRegistryRegistering(false);
      }
    }
  }, [characterName, agentName, isCurrentAuthority, loadRegistryStatus]);

  const syncRegistryProfile = useCallback(async () => {
    const requestAuthority = authorityTokenRef.current;
    if (!isCurrentAuthority(requestAuthority)) return;
    setRegistryRegistering(true);
    setRegistryError(null);
    try {
      await client.syncRegistryProfile({
        name: characterName || agentName,
      });
      if (!isCurrentAuthority(requestAuthority)) return;
      await loadRegistryStatus();
    } catch (err) {
      if (!isCurrentAuthority(requestAuthority)) return;
      setRegistryError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      if (isCurrentAuthority(requestAuthority)) {
        setRegistryRegistering(false);
      }
    }
  }, [characterName, agentName, isCurrentAuthority, loadRegistryStatus]);

  // ── Drop / Mint callbacks ──────────────────────────────────────────

  const loadDropStatus = useCallback(async () => {
    const requestAuthority = authorityTokenRef.current;
    if (!isCurrentAuthority(requestAuthority)) return;
    setDropLoading(true);
    try {
      const status = await client.getDropStatus();
      if (isCurrentAuthority(requestAuthority)) setDropStatus(status);
    } catch {
      // Non-critical -- drop may not be configured
    } finally {
      if (isCurrentAuthority(requestAuthority)) setDropLoading(false);
    }
  }, [isCurrentAuthority]);

  const mintFromDrop = useCallback(
    async (shiny: boolean) => {
      const requestAuthority = authorityTokenRef.current;
      if (!isCurrentAuthority(requestAuthority)) return;
      setMintInProgress(true);
      setMintShiny(shiny);
      setMintError(null);
      setMintResult(null);
      try {
        const result = await client.mintAgent({
          name: characterName || agentName,
          shiny,
        });
        if (!isCurrentAuthority(requestAuthority)) return;
        setMintResult(result);
        await loadRegistryStatus();
        if (!isCurrentAuthority(requestAuthority)) return;
        await loadDropStatus();
      } catch (err) {
        if (!isCurrentAuthority(requestAuthority)) return;
        setMintError(err instanceof Error ? err.message : "Mint failed");
      } finally {
        if (isCurrentAuthority(requestAuthority)) {
          setMintInProgress(false);
          setMintShiny(false);
        }
      }
    },
    [
      characterName,
      agentName,
      isCurrentAuthority,
      loadRegistryStatus,
      loadDropStatus,
    ],
  );

  // ── Whitelist callback ─────────────────────────────────────────────

  const loadWhitelistStatus = useCallback(async () => {
    const requestAuthority = authorityTokenRef.current;
    if (!isCurrentAuthority(requestAuthority)) return;
    setWhitelistLoading(true);
    try {
      const status = await client.getWhitelistStatus();
      if (isCurrentAuthority(requestAuthority)) setWhitelistStatus(status);
    } catch {
      // Non-critical
    } finally {
      if (isCurrentAuthority(requestAuthority)) setWhitelistLoading(false);
    }
  }, [isCurrentAuthority]);

  // ── Return ─────────────────────────────────────────────────────────

  const walletStateIsCurrent =
    walletStateAuthorityRef.current === authority &&
    getActiveAgentAuthority() === authority;
  const setWalletAddressesForAuthority = useCallback(
    (next: WalletAddresses | null) => {
      if (getActiveAgentAuthority() !== authority) return;
      setWalletAddresses(next);
    },
    [authority],
  );

  return {
    state: {
      browserEnabled,
      computerUseEnabled,
      walletEnabled,
      walletAddresses: walletStateIsCurrent ? walletAddresses : null,
      walletConfig: walletStateIsCurrent ? walletConfig : null,
      walletBalances: walletStateIsCurrent ? walletBalances : null,
      walletNfts: walletStateIsCurrent ? walletNfts : null,
      walletLoading: walletStateIsCurrent ? walletLoading : false,
      walletNftsLoading: walletStateIsCurrent ? walletNftsLoading : false,
      walletConfigStatus: walletStateIsCurrent ? walletConfigStatus : "idle",
      walletConfigError: walletStateIsCurrent ? walletConfigError : null,
      walletBalancesStatus: walletStateIsCurrent
        ? walletBalancesStatus
        : "idle",
      walletBalancesError: walletStateIsCurrent ? walletBalancesError : null,
      walletNftsStatus: walletStateIsCurrent ? walletNftsStatus : "idle",
      walletNftsError: walletStateIsCurrent ? walletNftsError : null,
      inventoryView,
      walletExportData: walletStateIsCurrent ? walletExportData : null,
      walletExportVisible: walletStateIsCurrent ? walletExportVisible : false,
      walletApiKeySaving: walletStateIsCurrent ? walletApiKeySaving : false,
      wallets: walletStateIsCurrent ? wallets : [],
      walletPrimary: walletStateIsCurrent ? walletPrimary : null,
      walletPrimaryRestarting,
      walletPrimaryPending: walletStateIsCurrent ? walletPrimaryPending : {},
      cloudRefreshing: walletStateIsCurrent ? cloudRefreshing : false,
      inventorySort,
      inventorySortDirection,
      inventoryChainFilters,
      walletError: walletStateIsCurrent ? walletError : null,
      registryStatus: walletStateIsCurrent ? registryStatus : null,
      registryLoading: walletStateIsCurrent ? registryLoading : false,
      registryRegistering: walletStateIsCurrent ? registryRegistering : false,
      registryError: walletStateIsCurrent ? registryError : null,
      dropStatus: walletStateIsCurrent ? dropStatus : null,
      dropLoading: walletStateIsCurrent ? dropLoading : false,
      mintInProgress: walletStateIsCurrent ? mintInProgress : false,
      mintResult: walletStateIsCurrent ? mintResult : null,
      mintError: walletStateIsCurrent ? mintError : null,
      mintShiny: walletStateIsCurrent ? mintShiny : false,
      whitelistStatus: walletStateIsCurrent ? whitelistStatus : null,
      whitelistLoading: walletStateIsCurrent ? whitelistLoading : false,
    },
    // Raw setters needed by AppContext for UI binding
    setBrowserEnabled,
    setComputerUseEnabled,
    setWalletEnabled,
    setWalletAddresses: setWalletAddressesForAuthority,
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
    setWalletPrimary,
    setPrimary: setWalletPrimary,
    refreshCloud: refreshCloudWallets,
    refreshCloudWallets,
    handleExportKeys,
    loadRegistryStatus,
    registerOnChain,
    syncRegistryProfile,
    loadDropStatus,
    mintFromDrop,
    loadWhitelistStatus,
  };
}
