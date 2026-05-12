/**
 * Config page — agent-level configuration.
 *
 * Sections:
 *   1. Wallet & RPC providers
 *   2. Secrets (modal)
 */

import {
  buildWalletRpcUpdateRequest,
  resolveInitialWalletRpcSelections,
  type WalletRpcSelections,
} from "@elizaos/shared";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApp } from "../../state";
import { preOpenWindow } from "../../utils";
import {
  BSC_RPC_OPTIONS,
  CloudServicesSection,
  EVM_RPC_OPTIONS,
  RpcConfigSection,
  type RpcProviderOption,
  type RpcSectionConfigMap,
  SOLANA_RPC_OPTIONS,
} from "./config-page-sections";
import { SecretsView } from "./SecretsView";

/* ── ConfigPageView ──────────────────────────────────────────────────── */

const CLOUD_RPC_SELECTIONS = {
  evm: "eliza-cloud",
  bsc: "eliza-cloud",
  solana: "eliza-cloud",
} as const satisfies WalletRpcSelections;

function areCloudRpcSelections(selections: WalletRpcSelections) {
  return (
    selections.evm === "eliza-cloud" &&
    selections.bsc === "eliza-cloud" &&
    selections.solana === "eliza-cloud"
  );
}

function firstCustomRpcProvider<T extends string>(
  options: readonly RpcProviderOption<T>[],
  fallback: T,
): T {
  return options.find((option) => option.id !== "eliza-cloud")?.id ?? fallback;
}

function resolveCustomRpcSelections(
  current: WalletRpcSelections,
): WalletRpcSelections {
  return {
    evm:
      current.evm === "eliza-cloud"
        ? firstCustomRpcProvider(EVM_RPC_OPTIONS, current.evm)
        : current.evm,
    bsc:
      current.bsc === "eliza-cloud"
        ? firstCustomRpcProvider(BSC_RPC_OPTIONS, current.bsc)
        : current.bsc,
    solana:
      current.solana === "eliza-cloud"
        ? firstCustomRpcProvider(SOLANA_RPC_OPTIONS, current.solana)
        : current.solana,
  };
}

export function ConfigPageView({
  embedded = false,
  onWalletSaveSuccess,
}: {
  embedded?: boolean;
  onWalletSaveSuccess?: () => void;
}) {
  const {
    t,
    elizaCloudConnected,
    elizaCloudLoginBusy,
    walletConfig,
    walletApiKeySaving,
    handleWalletApiKeySave,
    handleCloudLogin,
  } = useApp();

  const [secretsOpen, setSecretsOpen] = useState(false);
  const manualRpcModeSelection = useRef(false);

  const initialRpc = resolveInitialWalletRpcSelections(walletConfig);
  const initialEvmRpc = initialRpc.evm;
  const initialBscRpc = initialRpc.bsc;
  const initialSolanaRpc = initialRpc.solana;

  /* ── Mode: "cloud" or "custom" ─────────────────────────────────────── */
  const allCloud =
    areCloudRpcSelections(initialRpc) || (!walletConfig && elizaCloudConnected);
  const [rpcMode, setRpcMode] = useState<"cloud" | "custom">(
    allCloud ? "cloud" : "custom",
  );

  /* ── RPC provider field values ─────────────────────────────────────── */
  const [rpcFieldValues, setRpcFieldValues] = useState<Record<string, string>>(
    {},
  );

  const handleRpcFieldChange = useCallback((key: string, value: unknown) => {
    setRpcFieldValues((prev) => ({ ...prev, [key]: String(value ?? "") }));
  }, []);

  /* ── RPC provider selection state ──────────────────────────────────── */
  const initialSelectedRpc = allCloud ? CLOUD_RPC_SELECTIONS : initialRpc;
  const [selectedEvmRpc, setSelectedEvmRpc] = useState<
    WalletRpcSelections["evm"]
  >(initialSelectedRpc.evm);
  const [selectedBscRpc, setSelectedBscRpc] = useState<
    WalletRpcSelections["bsc"]
  >(initialSelectedRpc.bsc);
  const [selectedSolanaRpc, setSelectedSolanaRpc] = useState<
    WalletRpcSelections["solana"]
  >(initialSelectedRpc.solana);

  useEffect(() => {
    if (manualRpcModeSelection.current) {
      return;
    }
    const selections: WalletRpcSelections = {
      evm: initialEvmRpc,
      bsc: initialBscRpc,
      solana: initialSolanaRpc,
    };
    const nextMode = areCloudRpcSelections(selections) ? "cloud" : "custom";
    setRpcMode(nextMode);
    if (nextMode === "cloud") {
      setSelectedEvmRpc(CLOUD_RPC_SELECTIONS.evm);
      setSelectedBscRpc(CLOUD_RPC_SELECTIONS.bsc);
      setSelectedSolanaRpc(CLOUD_RPC_SELECTIONS.solana);
    } else {
      setSelectedEvmRpc(selections.evm);
      setSelectedBscRpc(selections.bsc);
      setSelectedSolanaRpc(selections.solana);
    }
  }, [initialBscRpc, initialEvmRpc, initialSolanaRpc]);

  /* When switching to cloud mode, set all providers to eliza-cloud */
  const handleModeChange = useCallback(
    (mode: "cloud" | "custom") => {
      manualRpcModeSelection.current = true;
      setRpcMode(mode);
      if (mode === "cloud") {
        setSelectedEvmRpc(CLOUD_RPC_SELECTIONS.evm);
        setSelectedBscRpc(CLOUD_RPC_SELECTIONS.bsc);
        setSelectedSolanaRpc(CLOUD_RPC_SELECTIONS.solana);
      } else {
        const customSelections = resolveCustomRpcSelections({
          evm: selectedEvmRpc,
          bsc: selectedBscRpc,
          solana: selectedSolanaRpc,
        });
        setSelectedEvmRpc(customSelections.evm);
        setSelectedBscRpc(customSelections.bsc);
        setSelectedSolanaRpc(customSelections.solana);
      }
    },
    [selectedBscRpc, selectedEvmRpc, selectedSolanaRpc],
  );

  const handleWalletSaveAll = useCallback(async () => {
    const config = buildWalletRpcUpdateRequest({
      walletConfig,
      rpcFieldValues,
      selectedProviders: {
        evm: selectedEvmRpc,
        bsc: selectedBscRpc,
        solana: selectedSolanaRpc,
      },
    });
    const saved = await handleWalletApiKeySave(config);
    if (saved) {
      onWalletSaveSuccess?.();
    }
  }, [
    handleWalletApiKeySave,
    onWalletSaveSuccess,
    rpcFieldValues,
    selectedBscRpc,
    selectedEvmRpc,
    selectedSolanaRpc,
    walletConfig,
  ]);

  const evmRpcConfigs: RpcSectionConfigMap = {
    alchemy: [
      {
        configKey: "ALCHEMY_API_KEY",
        label: t("onboarding.rpcAlchemyKey", {
          defaultValue: "Alchemy API Key",
        }),
        isSet: walletConfig?.alchemyKeySet ?? false,
      },
    ],
    infura: [
      {
        configKey: "INFURA_API_KEY",
        label: t("configpageview.InfuraApiKey", {
          defaultValue: "Infura API Key",
        }),
        isSet: walletConfig?.infuraKeySet ?? false,
      },
    ],
    ankr: [
      {
        configKey: "ANKR_API_KEY",
        label: t("configpageview.AnkrApiKey", {
          defaultValue: "Ankr API Key",
        }),
        isSet: walletConfig?.ankrKeySet ?? false,
      },
    ],
  };

  const bscRpcConfigs: RpcSectionConfigMap = {
    alchemy: [
      {
        configKey: "ALCHEMY_API_KEY",
        label: t("onboarding.rpcAlchemyKey", {
          defaultValue: "Alchemy API Key",
        }),
        isSet: walletConfig?.alchemyKeySet ?? false,
      },
    ],
    ankr: [
      {
        configKey: "ANKR_API_KEY",
        label: t("configpageview.AnkrApiKey", {
          defaultValue: "Ankr API Key",
        }),
        isSet: walletConfig?.ankrKeySet ?? false,
      },
    ],
    nodereal: [
      {
        configKey: "NODEREAL_BSC_RPC_URL",
        label: t("configpageview.NodeRealBscRpcUrl", {
          defaultValue: "NodeReal BSC RPC URL",
        }),
        isSet: walletConfig?.nodeRealBscRpcSet ?? false,
      },
    ],
    quicknode: [
      {
        configKey: "QUICKNODE_BSC_RPC_URL",
        label: t("configpageview.QuickNodeBscRpcUrl", {
          defaultValue: "QuickNode BSC RPC URL",
        }),
        isSet: walletConfig?.quickNodeBscRpcSet ?? false,
      },
    ],
  };

  const solanaRpcConfigs: RpcSectionConfigMap = {
    "helius-birdeye": [
      {
        configKey: "HELIUS_API_KEY",
        label: t("configpageview.HeliusApiKey", {
          defaultValue: "Helius API Key",
        }),
        isSet: walletConfig?.heliusKeySet ?? false,
      },
      {
        configKey: "BIRDEYE_API_KEY",
        label: t("configpageview.BirdeyeApiKey", {
          defaultValue: "Birdeye API Key",
        }),
        isSet: walletConfig?.birdeyeKeySet ?? false,
      },
    ],
  };

  const cloudStatusProps = {
    connected: elizaCloudConnected,
    loginBusy: elizaCloudLoginBusy,
    onLogin: () => void handleCloudLogin(preOpenWindow()),
  };

  const legacyRpcChains = walletConfig?.legacyCustomChains ?? [];
  const legacyRpcWarning =
    legacyRpcChains.length > 0
      ? t("configpageview.LegacyRawRpcWarning", {
          defaultValue:
            "Legacy raw RPC is still active for {{chains}}. Re-save a supported provider selection to migrate fully.",
          chains: legacyRpcChains.join(", "),
        })
      : null;

  /* Filter out eliza-cloud from per-chain options in custom mode */
  const filterCloudOption = <T extends string>(
    options: readonly RpcProviderOption<T>[],
  ) => options.filter((o) => o.id !== "eliza-cloud");

  return (
    <div>
      {!embedded && (
        <>
          <h2 className="text-lg font-bold mb-1">
            {t("configpageview.Config")}
          </h2>
          <p className="text-sm text-muted mb-5">
            {t("configpageview.WalletProvidersAnd")}
          </p>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          MODE SELECTOR: Eliza Cloud vs Custom RPC
          ═══════════════════════════════════════════════════════════════ */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
        <Button
          variant="ghost"
          data-testid="wallet-rpc-mode-cloud"
          onClick={() => handleModeChange("cloud")}
          className={`relative flex flex-col items-start gap-1.5 rounded-xl border-2 p-4 text-left transition-all h-auto !whitespace-normal ${
            rpcMode === "cloud"
              ? "border-accent bg-accent/8 shadow-[0_0_20px_rgba(var(--accent-rgb),0.1)]"
              : "border-border/40 bg-card/30 opacity-50 grayscale hover:opacity-70 hover:grayscale-0"
          }`}
        >
          <div className="flex items-center gap-2">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={rpcMode === "cloud" ? "text-accent" : "text-muted"}
            >
              <title>
                {t("configpageview.CloudModeSvgTitle", {
                  defaultValue: "Eliza Cloud managed RPC",
                })}
              </title>
              <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
            </svg>
            <span className="text-sm font-bold">
              {t("common.elizaCloud", {
                defaultValue: "Eliza Cloud",
              })}
            </span>
          </div>
          <span className="text-xs-tight text-muted leading-snug">
            {t("configpageview.CloudModeDesc", {
              defaultValue:
                "Managed RPC for EVM, BSC, and Solana via Eliza Cloud, with Helius on Solana.",
            })}
          </span>
          {rpcMode === "cloud" && (
            <span className="absolute top-3 right-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-2xs font-bold text-accent-fg">
              {"\u2713"}
            </span>
          )}
        </Button>

        <Button
          variant="ghost"
          onClick={() => handleModeChange("custom")}
          className={`relative flex flex-col items-start gap-1.5 rounded-xl border-2 p-4 text-left transition-all h-auto !whitespace-normal ${
            rpcMode === "custom"
              ? "border-accent bg-accent/8 shadow-[0_0_20px_rgba(var(--accent-rgb),0.1)]"
              : "border-border/40 bg-card/30 opacity-50 grayscale hover:opacity-70 hover:grayscale-0"
          }`}
        >
          <div className="flex items-center gap-2">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={rpcMode === "custom" ? "text-accent" : "text-muted"}
            >
              <title>
                {t("configpageview.CustomModeSvgTitle", {
                  defaultValue: "Custom RPC configuration",
                })}
              </title>
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
            </svg>
            <span className="text-sm font-bold">
              {t("configpageview.CustomModeTitle", {
                defaultValue: "Custom RPC",
              })}
            </span>
          </div>
          <span className="text-xs-tight text-muted leading-snug">
            {t("configpageview.CustomModeDesc", {
              defaultValue: "Bring your own API keys. Configure per chain.",
            })}
          </span>
          {rpcMode === "custom" && (
            <span className="absolute top-3 right-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent text-2xs font-bold text-accent-fg">
              ✓
            </span>
          )}
        </Button>
      </div>

      {rpcMode === "cloud" && (
        <div>
          {elizaCloudConnected ? (
            <>
              <div className="space-y-2">
                {[
                  {
                    label: "EVM",
                    desc: t("configpageview.EVMDesc", {
                      defaultValue: "Ethereum, Base, Arbitrum",
                    }),
                  },
                  {
                    label: "BSC",
                    desc: t("configpageview.BSCDesc", {
                      defaultValue: "BNB Smart Chain",
                    }),
                  },
                  {
                    label: "Solana",
                    desc: t("configpageview.SolanaDesc", {
                      defaultValue: "Solana mainnet",
                    }),
                  },
                ].map((chain) => (
                  <div
                    key={chain.label}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-bg/50"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-ok shrink-0" />
                    <span className="text-xs font-semibold text-txt">
                      {chain.label}
                    </span>
                    <span className="text-xs-tight text-muted">
                      {chain.desc}
                    </span>
                    <span className="text-2xs text-accent ml-auto font-medium">
                      {t("common.elizaCloud", {
                        defaultValue: "Eliza Cloud",
                      })}
                    </span>
                  </div>
                ))}
              </div>

              {!embedded ? <CloudServicesSection /> : null}
            </>
          ) : (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="text-muted"
              >
                <title>
                  {t("configpageview.CloudLoginRequiredSvgTitle", {
                    defaultValue: "Eliza Cloud login required",
                  })}
                </title>
                <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
              </svg>
              <div>
                <p className="text-sm font-semibold text-txt mb-1">
                  {t("elizaclouddashboard.ConnectElizaCloud", {
                    defaultValue: "Connect to Eliza Cloud",
                  })}
                </p>
              </div>
              <Button
                variant="default"
                size="sm"
                className="text-xs font-bold"
                onClick={() => void handleCloudLogin(preOpenWindow())}
                disabled={elizaCloudLoginBusy}
              >
                {elizaCloudLoginBusy
                  ? t("game.connecting", {
                      defaultValue: "Connecting...",
                    })
                  : t("elizaclouddashboard.ConnectElizaCloud", {
                      defaultValue: "Connect to Eliza Cloud",
                    })}
              </Button>
            </div>
          )}

          <div className="flex justify-end mt-4">
            <Button
              variant="default"
              size="sm"
              data-testid="wallet-rpc-save"
              className="text-xs-tight"
              onClick={() => {
                void handleWalletSaveAll();
              }}
              disabled={walletApiKeySaving}
            >
              {walletApiKeySaving ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          CUSTOM RPC MODE
          ═══════════════════════════════════════════════════════════════ */}
      {rpcMode === "custom" && (
        <div>
          <div className="flex items-center justify-between mb-4">
            <div className="font-bold text-sm">
              {t("configpageview.CustomRpcProviders", {
                defaultValue: "Custom RPC Providers",
              })}
            </div>
            <Button
              variant="outline"
              className="min-h-[2.625rem] px-4 rounded-[calc(var(--radius-lg)_+_2px)] flex items-center gap-1.5 text-xs text-muted hover:text-txt"
              onClick={() => setSecretsOpen(true)}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <title>
                  {t("configpageview.Secrets", { defaultValue: "Secrets" })}
                </title>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              {t("configpageview.Secrets", { defaultValue: "Secrets" })}
            </Button>
          </div>

          <div className="space-y-5">
            <RpcConfigSection
              title={t("configpageview.EVM", { defaultValue: "EVM" })}
              description={t("configpageview.EVMDesc", {
                defaultValue: "Ethereum, Base, Arbitrum",
              })}
              options={filterCloudOption(EVM_RPC_OPTIONS)}
              selectedProvider={
                selectedEvmRpc === "eliza-cloud"
                  ? (EVM_RPC_OPTIONS.find((o) => o.id !== "eliza-cloud")?.id ??
                    selectedEvmRpc)
                  : selectedEvmRpc
              }
              onSelect={(provider) => setSelectedEvmRpc(provider)}
              providerConfigs={evmRpcConfigs}
              rpcFieldValues={rpcFieldValues}
              onRpcFieldChange={handleRpcFieldChange}
              cloud={cloudStatusProps}
              containerClassName="flex flex-wrap gap-1.5"
              t={t}
            />
            <div className="py-1" />
            <RpcConfigSection
              title={t("configpageview.BSC", { defaultValue: "BSC" })}
              description={t("configpageview.BSCDesc", {
                defaultValue: "BNB Smart Chain",
              })}
              options={filterCloudOption(BSC_RPC_OPTIONS)}
              selectedProvider={
                selectedBscRpc === "eliza-cloud"
                  ? (BSC_RPC_OPTIONS.find((o) => o.id !== "eliza-cloud")?.id ??
                    selectedBscRpc)
                  : selectedBscRpc
              }
              onSelect={(provider) => setSelectedBscRpc(provider)}
              providerConfigs={bscRpcConfigs}
              rpcFieldValues={rpcFieldValues}
              onRpcFieldChange={handleRpcFieldChange}
              cloud={cloudStatusProps}
              containerClassName="flex flex-wrap gap-1.5"
              t={t}
            />
            <div className="py-1" />
            <RpcConfigSection
              title={t("configpageview.Solana", { defaultValue: "Solana" })}
              description={t("configpageview.SolanaDesc", {
                defaultValue: "Solana mainnet",
              })}
              options={filterCloudOption(SOLANA_RPC_OPTIONS)}
              selectedProvider={
                selectedSolanaRpc === "eliza-cloud"
                  ? (SOLANA_RPC_OPTIONS.find((o) => o.id !== "eliza-cloud")
                      ?.id ?? selectedSolanaRpc)
                  : selectedSolanaRpc
              }
              onSelect={(provider) => setSelectedSolanaRpc(provider)}
              providerConfigs={solanaRpcConfigs}
              rpcFieldValues={rpcFieldValues}
              onRpcFieldChange={handleRpcFieldChange}
              cloud={cloudStatusProps}
              containerClassName="flex flex-wrap gap-1.5"
              t={t}
            />
          </div>

          {legacyRpcWarning && (
            <div className="mt-4 rounded-lg border border-warn bg-warn-subtle px-3 py-2 text-xs-tight text-txt">
              {legacyRpcWarning}
            </div>
          )}

          <div className="flex justify-end mt-4">
            <Button
              variant="default"
              size="sm"
              data-testid="wallet-rpc-save"
              className="text-xs-tight"
              onClick={() => {
                void handleWalletSaveAll();
              }}
              disabled={walletApiKeySaving}
            >
              {walletApiKeySaving ? t("common.saving") : t("common.save")}
            </Button>
          </div>
        </div>
      )}

      {/* ── Secrets modal ── */}
      <Dialog open={secretsOpen} onOpenChange={setSecretsOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[min(calc(100%_-_2rem),42rem)] max-h-[min(88vh,48rem)] overflow-hidden rounded-2xl border border-border/70 bg-card/96 p-0 shadow-2xl"
        >
          <div className="flex max-h-[min(88vh,48rem)] flex-col">
            <DialogHeader className="flex flex-row items-center justify-between px-5 py-4">
              <div className="flex items-center gap-2">
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-accent"
                >
                  <title>{t("configpageview.SecretsVault")}</title>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <DialogTitle className="text-sm font-bold">
                  {t("configpageview.SecretsVault1")}
                </DialogTitle>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted hover:text-txt text-lg leading-none"
                onClick={() => setSecretsOpen(false)}
                aria-label={t("common.close")}
              >
                {t("bugreportmodal.Times")}
              </Button>
            </DialogHeader>
            <div className="flex-1 min-h-0 overflow-y-auto p-5">
              <SecretsView />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
