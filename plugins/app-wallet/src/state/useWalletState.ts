// @ts-nocheck — ts source recreated from dist; types remain accurate via dist .d.ts contract
import { useCallback, useEffect, useRef, useState } from "react";
import {
  client
} from "@elizaos/ui";
import { confirmDesktopAction } from "@elizaos/ui";
import {
  loadBrowserEnabled,
  loadComputerUseEnabled,
  loadWalletEnabled,
  saveBrowserEnabled,
  saveComputerUseEnabled,
  saveWalletEnabled
} from "@elizaos/ui";
function useWalletState({
  setActionNotice,
  promptModal,
  agentName,
  characterName
}) {
  const [walletEnabled, setWalletEnabledRaw] = useState(loadWalletEnabled);
  const setWalletEnabled = useCallback((v) => {
    setWalletEnabledRaw(v);
    saveWalletEnabled(v);
    void client.updateConfig({ ui: { capabilities: { wallet: v } } }).catch(() => {
    });
  }, []);
  const [browserEnabled, setBrowserEnabledRaw] = useState(loadBrowserEnabled);
  const setBrowserEnabled = useCallback((v) => {
    setBrowserEnabledRaw(v);
    saveBrowserEnabled(v);
    void client.updateConfig({ ui: { capabilities: { browser: v } } }).catch(() => {
    });
  }, []);
  const [computerUseEnabled, setComputerUseEnabledRaw] = useState(
    loadComputerUseEnabled
  );
  const setComputerUseEnabled = useCallback((v) => {
    setComputerUseEnabledRaw(v);
    saveComputerUseEnabled(v);
    void client.updateConfig({ ui: { capabilities: { computerUse: v } } }).catch(() => {
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    void client.getConfig().then((cfg) => {
      if (cancelled) return;
      const ui = cfg.ui;
      const caps = ui?.capabilities;
      if (!caps || typeof caps !== "object") return;
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
    }).catch(() => {
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [walletAddresses, setWalletAddresses] = useState(null);
  const [walletConfig, setWalletConfig] = useState(
    null
  );
  const [walletBalances, setWalletBalances] = useState(null);
  const [walletNfts, setWalletNfts] = useState(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletNftsLoading, setWalletNftsLoading] = useState(false);
  const [inventoryView, setInventoryView] = useState(
    "tokens"
  );
  const [walletExportData, setWalletExportData] = useState(null);
  const [walletExportVisible, setWalletExportVisible] = useState(false);
  const [walletApiKeySaving, setWalletApiKeySaving] = useState(false);
  const [wallets, setWallets] = useState([]);
  const [walletPrimary, setWalletPrimaryMap] = useState(null);
  const [walletPrimaryRestarting] = useState({});
  const [walletPrimaryPending, setWalletPrimaryPending] = useState({});
  const [cloudRefreshing, setCloudRefreshing] = useState(false);
  const [inventorySort, setInventorySort] = useState("value");
  const [inventorySortDirection, setInventorySortDirection] = useState("desc");
  const [inventoryChainFilters, setInventoryChainFilters] = useState({
    ethereum: true,
    base: true,
    bsc: true,
    avax: true,
    solana: true
  });
  const [walletError, setWalletError] = useState(null);
  const [registryStatus, setRegistryStatus] = useState(
    null
  );
  const [registryLoading, setRegistryLoading] = useState(false);
  const [registryRegistering, setRegistryRegistering] = useState(false);
  const [registryError, setRegistryError] = useState(null);
  const [dropStatus, setDropStatus] = useState(null);
  const [dropLoading, setDropLoading] = useState(false);
  const [mintInProgress, setMintInProgress] = useState(false);
  const [mintResult, setMintResult] = useState(null);
  const [mintError, setMintError] = useState(null);
  const [mintShiny, setMintShiny] = useState(false);
  const [whitelistStatus, setWhitelistStatus] = useState(null);
  const [whitelistLoading, setWhitelistLoading] = useState(false);
  const walletApiKeySavingRef = useRef(false);
  const walletExportTimerRef = useRef(
    null
  );
  const fetchWalletConfig = useCallback(async () => {
    const cfg = await client.getWalletConfig();
    setWalletConfig(cfg);
    setWalletAddresses({
      evmAddress: cfg.evmAddress,
      solanaAddress: cfg.solanaAddress
    });
    setWallets(Array.isArray(cfg.wallets) ? cfg.wallets : []);
    setWalletPrimaryMap(cfg.primary ?? null);
    return cfg;
  }, []);
  const hasWalletSource = useCallback(
    (config, chain, source) => (config?.wallets ?? []).some(
      (wallet) => wallet.chain === chain && wallet.source === source && typeof wallet.address === "string" && wallet.address.trim().length > 0
    ),
    []
  );
  const normalizeCloudWalletNotice = useCallback((warning) => {
    const detail = warning.replace(
      /^Cloud (evm|solana) wallet import failed:\s*/i,
      ""
    );
    if (/Invalid Solana address \(base58, 32–44 chars\)/i.test(detail)) {
      return "the connected Eliza Cloud backend is still using the legacy Solana wallet contract";
    }
    return detail;
  }, []);
  const summarizeCloudWalletImport = useCallback(
    (config, warnings) => {
      const evmConnected = hasWalletSource(config, "evm", "cloud");
      const solanaConnected = hasWalletSource(config, "solana", "cloud");
      if (evmConnected && solanaConnected) {
        return { text: "Cloud wallets connected.", tone: "success" };
      }
      const solanaWarning = warnings?.find(
        (warning) => /Cloud solana wallet import failed:/i.test(warning)
      );
      if (evmConnected && solanaWarning) {
        return {
          text: `EVM cloud wallet connected. Solana cloud wallet is unavailable because ${normalizeCloudWalletNotice(solanaWarning)}.`,
          tone: "info"
        };
      }
      const evmWarning = warnings?.find(
        (warning) => /Cloud evm wallet import failed:/i.test(warning)
      );
      if (solanaConnected && evmWarning) {
        return {
          text: `Solana cloud wallet connected. EVM cloud wallet is unavailable because ${normalizeCloudWalletNotice(evmWarning)}.`,
          tone: "info"
        };
      }
      return { text: "Cloud wallet import queued.", tone: "success" };
    },
    [hasWalletSource, normalizeCloudWalletNotice]
  );
  const loadWalletConfig = useCallback(async () => {
    try {
      await fetchWalletConfig();
      setWalletError(null);
    } catch (err) {
      setWalletError(
        `Failed to load wallet config: ${err instanceof Error ? err.message : "network error"}`
      );
    }
  }, [fetchWalletConfig]);
  const loadBalances = useCallback(async () => {
    setWalletLoading(true);
    setWalletError(null);
    try {
      const b = await client.getWalletBalances();
      setWalletBalances(b);
    } catch (err) {
      setWalletError(
        `Failed to fetch balances: ${err instanceof Error ? err.message : "network error"}`
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
        `Failed to fetch NFTs: ${err instanceof Error ? err.message : "network error"}`
      );
    }
    setWalletNftsLoading(false);
  }, []);
  const handleWalletApiKeySave = useCallback(
    async (config) => {
      if (Object.keys(config.credentials ?? {}).length === 0 && Object.keys(config.selections ?? {}).length === 0) {
        return false;
      }
      if (walletApiKeySavingRef.current || walletApiKeySaving) return false;
      walletApiKeySavingRef.current = true;
      setWalletApiKeySaving(true);
      setWalletError(null);
      try {
        await client.updateWalletConfig(config);
        const selectedProviders = config.selections;
        const shouldImportCloudWallets = selectedProviders.evm === "eliza-cloud" && selectedProviders.bsc === "eliza-cloud" && selectedProviders.solana === "eliza-cloud";
        let walletConfigAfterSave;
        if (shouldImportCloudWallets) {
          setCloudRefreshing(true);
          try {
            const refreshResult = await client.refreshCloudWallets();
            walletConfigAfterSave = await fetchWalletConfig();
            const notice = summarizeCloudWalletImport(
              walletConfigAfterSave,
              refreshResult?.warnings
            );
            setActionNotice(notice.text, notice.tone);
          } finally {
            setCloudRefreshing(false);
          }
        } else {
          walletConfigAfterSave = await fetchWalletConfig();
          setActionNotice(
            "Wallet RPC settings saved. Restart required to apply.",
            "success"
          );
        }
        await loadBalances();
        if (!walletConfigAfterSave) {
          await loadWalletConfig();
        }
        return true;
      } catch (err) {
        setWalletError(
          `Failed to save API keys: ${err instanceof Error ? err.message : "network error"}`
        );
        return false;
      } finally {
        walletApiKeySavingRef.current = false;
        setWalletApiKeySaving(false);
      }
    },
    [
      walletApiKeySaving,
      fetchWalletConfig,
      loadBalances,
      loadWalletConfig,
      setActionNotice,
      summarizeCloudWalletImport
    ]
  );
  const refreshCloudWallets = useCallback(async () => {
    setCloudRefreshing(true);
    setWalletError(null);
    try {
      const result = await client.refreshCloudWallets();
      const nextConfig = await fetchWalletConfig();
      const notice = summarizeCloudWalletImport(nextConfig, result?.warnings);
      setActionNotice(notice.text, notice.tone);
      await loadBalances();
    } catch (err) {
      setWalletError(
        `Failed to refresh cloud wallets: ${err instanceof Error ? err.message : "network error"}`
      );
    } finally {
      setCloudRefreshing(false);
    }
  }, [
    fetchWalletConfig,
    loadBalances,
    setActionNotice,
    summarizeCloudWalletImport
  ]);
  const setWalletPrimary = useCallback(
    async (chain, source) => {
      setWalletPrimaryPending((prev) => ({ ...prev, [chain]: true }));
      setWalletError(null);
      try {
        let currentConfig = walletConfig;
        if (!currentConfig) {
          currentConfig = await fetchWalletConfig();
        }
        if (!hasWalletSource(currentConfig, chain, source)) {
          if (source === "local") {
            await client.generateWallet({ chain, source: "local" });
          } else {
            setCloudRefreshing(true);
            try {
              await client.refreshCloudWallets();
            } finally {
              setCloudRefreshing(false);
            }
          }
          currentConfig = await fetchWalletConfig();
        }
        await client.setWalletPrimary({ chain, source });
        await fetchWalletConfig();
        await loadBalances();
      } catch (err) {
        setWalletError(
          `Failed to switch wallet primary: ${err instanceof Error ? err.message : "network error"}`
        );
      } finally {
        setWalletPrimaryPending((prev) => {
          const next = { ...prev };
          delete next[chain];
          return next;
        });
      }
    },
    [fetchWalletConfig, hasWalletSource, loadBalances, walletConfig]
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
      detail: "NEVER share your private keys with anyone. Anyone with your private keys can steal all funds in your wallets.",
      confirmLabel: "Continue",
      cancelLabel: "Cancel",
      type: "warning"
    });
    if (!confirmed) return;
    const exportToken = await promptModal({
      title: "Wallet Export Token",
      message: "Enter your wallet export token (ELIZA_WALLET_EXPORT_TOKEN):",
      placeholder: "ELIZA_WALLET_EXPORT_TOKEN",
      confirmLabel: "Export",
      cancelLabel: "Cancel"
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
      }, 6e4);
    } catch (err) {
      setWalletError(
        `Failed to export keys: ${err instanceof Error ? err.message : "network error"}`
      );
    }
  }, [promptModal, walletExportVisible]);
  const loadRegistryStatus = useCallback(async () => {
    setRegistryLoading(true);
    setRegistryError(null);
    try {
      const status = await client.getRegistryStatus();
      setRegistryStatus(status);
    } catch (err) {
      setRegistryError(
        err instanceof Error ? err.message : "Failed to load registry status"
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
        name: characterName || agentName
      });
      await loadRegistryStatus();
    } catch (err) {
      setRegistryError(
        err instanceof Error ? err.message : "Registration failed"
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
        name: characterName || agentName
      });
      await loadRegistryStatus();
    } catch (err) {
      setRegistryError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setRegistryRegistering(false);
    }
  }, [characterName, agentName, loadRegistryStatus]);
  const loadDropStatus = useCallback(async () => {
    setDropLoading(true);
    try {
      const status = await client.getDropStatus();
      setDropStatus(status);
    } catch {
    } finally {
      setDropLoading(false);
    }
  }, []);
  const mintFromDrop = useCallback(
    async (shiny) => {
      setMintInProgress(true);
      setMintShiny(shiny);
      setMintError(null);
      setMintResult(null);
      try {
        const result = await client.mintAgent({
          name: characterName || agentName,
          shiny
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
    [characterName, agentName, loadRegistryStatus, loadDropStatus]
  );
  const loadWhitelistStatus = useCallback(async () => {
    setWhitelistLoading(true);
    try {
      const status = await client.getWhitelistStatus();
      setWhitelistStatus(status);
    } catch {
    } finally {
      setWhitelistLoading(false);
    }
  }, []);
  return {
    state: {
      browserEnabled,
      computerUseEnabled,
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
      wallets,
      walletPrimary,
      walletPrimaryRestarting,
      walletPrimaryPending,
      cloudRefreshing,
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
      whitelistLoading
    },
    // Raw setters needed by AppContext for UI binding
    setBrowserEnabled,
    setComputerUseEnabled,
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
    loadWhitelistStatus
  };
}
export {
  useWalletState
};
//# sourceMappingURL=useWalletState.js.map