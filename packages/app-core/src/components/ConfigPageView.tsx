/**
 * Config page — agent-level configuration.
 *
 * Sections:
 *   1. Wallet & RPC providers
 *   2. Secrets (modal)
 */

import {
  WALLET_RPC_PROVIDER_OPTIONS,
  type WalletRpcSelections,
} from "@elizaos/autonomous/contracts/wallet";
import { useCallback, useEffect, useState } from "react";
import { client } from "../api";
import {
  ConfigRenderer,
  defaultRegistry,
  type JsonSchemaObject,
} from "../config";
import { useApp } from "../state";
import type { ConfigUiHint } from "../types";
import {
  buildWalletRpcUpdateRequest,
  resolveInitialWalletRpcSelections,
} from "../wallet-rpc";
import { SecretsView } from "./SecretsView";

type RpcProviderOption<T extends string> = {
  id: T;
  label: string;
};

type RpcFieldDefinition = {
  configKey: string;
  label: string;
  isSet: boolean;
};

type RpcFieldGroup = ReadonlyArray<RpcFieldDefinition>;

type RpcSectionConfigMap = Record<string, RpcFieldGroup>;

const EVM_RPC_OPTIONS = WALLET_RPC_PROVIDER_OPTIONS.evm;
const BSC_RPC_OPTIONS = WALLET_RPC_PROVIDER_OPTIONS.bsc;
const SOLANA_RPC_OPTIONS = WALLET_RPC_PROVIDER_OPTIONS.solana;

type CloudRpcStatusProps = {
  connected: boolean;
  credits: number | null;
  creditsLow: boolean;
  creditsCritical: boolean;
  topUpUrl: string | null;
  loginBusy: boolean;
  onLogin: () => void;
};

function CloudRpcStatus({
  connected,
  credits,
  creditsLow,
  creditsCritical,
  loginBusy,
  onLogin,
}: CloudRpcStatusProps) {
  const { t, setState, setTab } = useApp();
  if (connected) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-block w-2 h-2 rounded-full bg-[var(--ok)]" />
        <span className="font-semibold">
          Connected to Eliza Cloud
        </span>
        {credits !== null && (
          <span className="text-[var(--muted)] ml-auto">
            {t("configpageview.Credits")}{" "}
            <span
              className={
                creditsCritical
                  ? "text-[var(--danger)] font-bold"
                  : creditsLow
                    ? "rounded-md bg-[var(--warn-subtle)] px-1.5 py-0.5 text-[var(--text)] font-bold"
                    : ""
              }
            >
              ${credits.toFixed(2)}
            </span>
            <button
              type="button"
              onClick={() => {
                setState("cloudDashboardView", "billing");
                setTab("settings");
              }}
              className="ml-1.5 text-[10px] text-[var(--text)] underline decoration-[var(--accent)] underline-offset-2 hover:opacity-80 bg-transparent border-0 p-0 cursor-pointer"
            >
              {t("configpageview.TopUp")}
            </button>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-block w-2 h-2 rounded-full bg-[var(--muted)]" />
        <span className="text-[var(--muted)]">
          Requires Eliza Cloud
        </span>
      </div>
      <button
        type="button"
        className="btn text-xs py-[3px] px-3 !mt-0 font-bold"
        onClick={() => void onLogin()}
        disabled={loginBusy}
      >
        {loginBusy ? "Connecting..." : "Log in"}
      </button>
    </div>
  );
}

function buildRpcRendererConfig(
  selectedProvider: string,
  providerConfigs: RpcSectionConfigMap,
  rpcFieldValues: Record<string, string>,
) {
  const fields = providerConfigs[selectedProvider];
  if (!fields?.length) return null;

  const props: {
    schema: JsonSchemaObject;
    hints: Record<string, ConfigUiHint>;
    values: Record<string, unknown>;
    setKeys: Set<string>;
  } = {
    schema: {
      type: "object",
      properties: {},
      required: [],
    },
    hints: {},
    values: {},
    setKeys: new Set<string>(),
  };

  for (const field of fields) {
    props.schema.properties[field.configKey] = {
      type: "string",
      description: field.label,
    };
    props.hints[field.configKey] = {
      label: field.label,
      sensitive: true,
      placeholder: field.isSet
        ? "Already set — leave blank to keep"
        : "Enter API key",
      width: "full",
    };
    if (rpcFieldValues[field.configKey] !== undefined) {
      props.values[field.configKey] = rpcFieldValues[field.configKey];
    }
    if (field.isSet) {
      props.setKeys.add(field.configKey);
    }
  }

  return props;
}

type RpcSectionCloudProps = CloudRpcStatusProps;

type RpcSectionProps<T extends string> = {
  title: string;
  description: string;
  options: readonly RpcProviderOption<T>[];
  selectedProvider: T;
  onSelect: (provider: T) => void;
  providerConfigs: RpcSectionConfigMap;
  rpcFieldValues: Record<string, string>;
  onRpcFieldChange: (key: string, value: unknown) => void;
  cloud: RpcSectionCloudProps;
  containerClassName: string;
};

function RpcConfigSection<T extends string>({
  title,
  description,
  options,
  selectedProvider,
  onSelect,
  providerConfigs,
  rpcFieldValues,
  onRpcFieldChange,
  cloud,
  containerClassName,
}: RpcSectionProps<T>) {
  const rpcConfig = buildRpcRendererConfig(
    selectedProvider,
    providerConfigs,
    rpcFieldValues,
  );

  return (
    <div>
      <div className="text-xs font-bold mb-1">{title}</div>
      <div className="text-[11px] text-[var(--muted)] mb-2">{description}</div>

      {renderRpcProviderButtons(
        options,
        selectedProvider,
        onSelect,
        containerClassName,
        (key: string) => {
          // hack to get t function without breaking hook rules
          return key === "elizaclouddashboard.ElizaCloud"
            ? "Eliza Cloud"
            : key;
        },
      )}

      <div className="mt-3">
        {selectedProvider === "eliza-cloud" ? (
          <CloudRpcStatus
            connected={cloud.connected}
            credits={cloud.credits}
            creditsLow={cloud.creditsLow}
            creditsCritical={cloud.creditsCritical}
            topUpUrl={cloud.topUpUrl}
            loginBusy={cloud.loginBusy}
            onLogin={() => void cloud.onLogin()}
          />
        ) : rpcConfig ? (
          <ConfigRenderer
            schema={rpcConfig.schema}
            hints={rpcConfig.hints}
            values={rpcConfig.values}
            setKeys={rpcConfig.setKeys}
            registry={defaultRegistry}
            onChange={onRpcFieldChange}
          />
        ) : null}
      </div>
    </div>
  );
}

function renderRpcProviderButtons<T extends string>(
  options: readonly RpcProviderOption<T>[],
  selectedProvider: T,
  onSelect: (provider: T) => void,
  containerClassName: string,
  tFallback?: (key: string) => string,
) {
  return (
    <div className={containerClassName}>
      {options.map((provider) => {
        const active = selectedProvider === provider.id;
        return (
          <button
            type="button"
            key={provider.id}
            className={`flex min-h-[44px] items-center justify-center rounded-lg border px-3 py-2 text-center text-xs font-semibold leading-tight shadow-sm transition-colors ${
              active
                ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]"
                : "border-[var(--border)] bg-[var(--card)] text-[var(--text)] hover:border-[var(--accent)] hover:bg-[var(--bg-hover)]"
            }`}
            onClick={() => onSelect(provider.id)}
          >
            <div className="leading-tight">
              {provider.id === "eliza-cloud" && tFallback
                ? tFallback("elizaclouddashboard.ElizaCloud")
                : provider.label}
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ── Cloud services toggle section ───────────────────────────────────── */

type CloudServiceKey = "inference" | "rpc" | "media" | "tts" | "embeddings";

const CLOUD_SERVICE_DEFS: {
  key: CloudServiceKey;
  label: string;
  description: string;
}[] = [
  {
    key: "inference",
    label: "Model Inference",
    description: `Use Eliza Cloud for LLM calls. Turn off to use your own API keys (Anthropic, OpenAI, etc.)`,
  },
  {
    key: "rpc",
    label: "Blockchain RPC",
    description: `Use Eliza Cloud RPC endpoints for EVM, BSC, and Solana`,
  },
  {
    key: "media",
    label: "Media Generation",
    description: `Use Eliza Cloud for image, video, audio, and vision`,
  },
  {
    key: "tts",
    label: "Text-to-Speech",
    description: `Use Eliza Cloud for TTS voice synthesis`,
  },
  {
    key: "embeddings",
    label: "Embeddings",
    description: `Use Eliza Cloud for text embedding generation`,
  },
];

function ToggleSwitch({
  checked,
  disabled,
  onChange,
  id,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  id: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={id}
      disabled={disabled}
      onClick={onChange}
      className={`relative shrink-0 cursor-pointer w-11 h-6 rounded-full border transition-all duration-200 p-0 ${
        checked
          ? "border-accent/50 bg-accent/20"
          : "border-border bg-input"
      }`}
    >
      <span
        className={`block w-[18px] h-[18px] rounded-full transition-all duration-200 mt-px ${
          checked
            ? "bg-accent translate-x-[22px]"
            : "bg-muted translate-x-[2px]"
        }`}
      />
    </button>
  );
}

function CloudServicesSection() {
  const { t } = useApp();
  const [services, setServices] = useState<Record<CloudServiceKey, boolean>>({
    inference: true,
    rpc: true,
    media: true,
    tts: true,
    embeddings: true,
  });
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [needsRestart, setNeedsRestart] = useState(false);

  useEffect(() => {
    let cancelled = false;
    client
      .getConfig()
      .then((cfg) => {
        if (cancelled) return;
        const cloud = cfg.cloud as
          | { services?: Record<string, boolean> }
          | undefined;
        if (cloud?.services) {
          setServices((prev) => ({
            ...prev,
            ...Object.fromEntries(
              Object.entries(cloud.services ?? {}).filter(
                ([, v]) => typeof v === "boolean",
              ),
            ),
          }));
        }
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = useCallback(
    async (key: CloudServiceKey) => {
      const newValue = !services[key];
      const updated = { ...services, [key]: newValue };
      setServices(updated);
      setSaving(true);
      const inferenceMode = updated.inference ? "cloud" : "byok";
      try {
        await client.updateConfig({
          cloud: { services: updated, inferenceMode },
        });
        setNeedsRestart(true);
      } catch (err) {
        setServices(services);
        console.error("[config] Failed to save cloud services:", err);
      } finally {
        setSaving(false);
      }
    },
    [services],
  );

  if (!loaded) return null;

  return (
    <div className="mt-4 p-5 border border-border rounded-xl bg-card">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold">
          {t("configpageview.CloudServices") || "Cloud Services"}
        </div>
        {needsRestart && (
          <span className="text-[11px] font-medium px-2.5 py-0.5 rounded-full border border-accent/30 bg-accent/8 text-accent">
            Restart required
          </span>
        )}
      </div>
      <p className="text-xs text-muted mb-4 leading-snug">
        Choose which services to use from Eliza Cloud. Disable inference to use
        your own API keys instead.
      </p>
      <div className="flex flex-col gap-2">
        {CLOUD_SERVICE_DEFS.map(({ key, label, description }) => (
          <div
            key={key}
            className={`flex items-center justify-between p-3 border border-border rounded-lg transition-colors ${
              services[key] ? "bg-accent/5" : ""
            }`}
          >
            <div className="flex-1 min-w-0 mr-4">
              <div
                id={`cloud-service-${key}`}
                className="text-[13px] font-medium text-txt"
              >
                {label}
              </div>
              <div className="text-[11px] text-muted mt-0.5">
                {description}
              </div>
            </div>
            <ToggleSwitch
              checked={services[key]}
              disabled={saving}
              onChange={() => void handleToggle(key)}
              id={`cloud-service-${key}`}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── ConfigPageView ──────────────────────────────────────────────────── */

export function ConfigPageView({ embedded = false }: { embedded?: boolean }) {
  const {
    t,
    elizaCloudConnected,
    elizaCloudCredits,
    elizaCloudCreditsLow,
    elizaCloudCreditsCritical,
    elizaCloudTopUpUrl,
    elizaCloudLoginBusy,
    walletConfig,
    walletApiKeySaving,
    handleWalletApiKeySave,
    handleCloudLogin,
  } = useApp();

  const [secretsOpen, setSecretsOpen] = useState(false);

  /* ── RPC provider field values ─────────────────────────────────────── */
  const [rpcFieldValues, setRpcFieldValues] = useState<Record<string, string>>(
    {},
  );

  const handleRpcFieldChange = useCallback((key: string, value: unknown) => {
    setRpcFieldValues((prev) => ({ ...prev, [key]: String(value ?? "") }));
  }, []);

  /* ── RPC provider selection state ──────────────────────────────────── */
  const initialRpc = resolveInitialWalletRpcSelections(walletConfig);
  const [selectedEvmRpc, setSelectedEvmRpc] = useState<
    WalletRpcSelections["evm"]
  >(initialRpc.evm);
  const [selectedBscRpc, setSelectedBscRpc] = useState<
    WalletRpcSelections["bsc"]
  >(initialRpc.bsc);
  const [selectedSolanaRpc, setSelectedSolanaRpc] = useState<
    WalletRpcSelections["solana"]
  >(initialRpc.solana);

  useEffect(() => {
    const selections = resolveInitialWalletRpcSelections(walletConfig);
    setSelectedEvmRpc(selections.evm);
    setSelectedBscRpc(selections.bsc);
    setSelectedSolanaRpc(selections.solana);
  }, [walletConfig]);

  const handleWalletSaveAll = useCallback(() => {
    const config = buildWalletRpcUpdateRequest({
      walletConfig,
      rpcFieldValues,
      selectedProviders: {
        evm: selectedEvmRpc,
        bsc: selectedBscRpc,
        solana: selectedSolanaRpc,
      },
    });
    void handleWalletApiKeySave(config);
  }, [
    handleWalletApiKeySave,
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
        label: "Alchemy API Key",
        isSet: walletConfig?.alchemyKeySet ?? false,
      },
    ],
    infura: [
      {
        configKey: "INFURA_API_KEY",
        label: "Infura API Key",
        isSet: walletConfig?.infuraKeySet ?? false,
      },
    ],
    ankr: [
      {
        configKey: "ANKR_API_KEY",
        label: "Ankr API Key",
        isSet: walletConfig?.ankrKeySet ?? false,
      },
    ],
  };

  const bscRpcConfigs: RpcSectionConfigMap = {
    alchemy: [
      {
        configKey: "ALCHEMY_API_KEY",
        label: "Alchemy API Key",
        isSet: walletConfig?.alchemyKeySet ?? false,
      },
    ],
    ankr: [
      {
        configKey: "ANKR_API_KEY",
        label: "Ankr API Key",
        isSet: walletConfig?.ankrKeySet ?? false,
      },
    ],
    nodereal: [
      {
        configKey: "NODEREAL_BSC_RPC_URL",
        label: "NodeReal BSC RPC URL",
        isSet: walletConfig?.nodeRealBscRpcSet ?? false,
      },
    ],
    quicknode: [
      {
        configKey: "QUICKNODE_BSC_RPC_URL",
        label: "QuickNode BSC RPC URL",
        isSet: walletConfig?.quickNodeBscRpcSet ?? false,
      },
    ],
  };

  const solanaRpcConfigs: RpcSectionConfigMap = {
    "helius-birdeye": [
      {
        configKey: "HELIUS_API_KEY",
        label: "Helius API Key",
        isSet: walletConfig?.heliusKeySet ?? false,
      },
      {
        configKey: "BIRDEYE_API_KEY",
        label: "Birdeye API Key",
        isSet: walletConfig?.birdeyeKeySet ?? false,
      },
    ],
  };

  const cloudStatusProps = {
    connected: elizaCloudConnected,
    credits: elizaCloudCredits,
    creditsLow: elizaCloudCreditsLow,
    creditsCritical: elizaCloudCreditsCritical,
    topUpUrl: elizaCloudTopUpUrl,
    loginBusy: elizaCloudLoginBusy,
    onLogin: () => void handleCloudLogin(),
  };

  const legacyRpcChains = walletConfig?.legacyCustomChains ?? [];
  const legacyRpcWarning =
    legacyRpcChains.length > 0
      ? `Legacy raw RPC is still active for ${legacyRpcChains.join(", ")}. Re-save a supported provider selection to migrate fully.`
      : null;

  return (
    <div>
      {!embedded && (
        <>
          <h2 className="text-lg font-bold mb-1">
            {t("configpageview.Config")}
          </h2>
          <p className="text-[13px] text-[var(--muted)] mb-5">
            {t("configpageview.WalletProvidersAnd")}
          </p>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════════
          UNIFIED CLOUD & RPC CONFIGURATION
          ═══════════════════════════════════════════════════════════════ */}

      {/* Cloud status bar */}
      {elizaCloudConnected && (
        <div className="flex items-center gap-2.5 mb-4 p-3 rounded-lg bg-accent/5 border border-accent/15">
          <span className="w-2 h-2 rounded-full bg-ok shrink-0" />
          <span className="text-[13px] font-semibold text-txt">Eliza Cloud</span>
          {elizaCloudCredits !== null && (
            <span className="text-xs text-muted ml-auto flex items-center gap-1.5">
              <span
                className={
                  elizaCloudCreditsCritical
                    ? "text-danger font-bold"
                    : elizaCloudCreditsLow
                      ? "text-warn font-bold"
                      : "text-txt font-semibold"
                }
              >
                ${elizaCloudCredits.toFixed(2)}
              </span>
              {elizaCloudTopUpUrl && (
                <a href={elizaCloudTopUpUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-accent underline underline-offset-2">Top up</a>
              )}
            </span>
          )}
        </div>
      )}

      {/* Cloud Services */}
      {elizaCloudConnected && <CloudServicesSection />}

      {/* Custom RPC — only show when user wants BYOK */}
      {!elizaCloudConnected && (
        <div className="mt-4 p-5 border border-border rounded-xl bg-card">
          <div className="flex items-center justify-between mb-4">
            <div className="font-bold text-sm">Custom RPC Providers</div>
            <button
              type="button"
              className="settings-button flex items-center gap-1.5 text-[12px] text-[var(--muted)] hover:text-[var(--txt)] bg-transparent border border-[var(--border)] rounded-lg cursor-pointer transition-colors hover:border-[var(--accent)]"
              onClick={() => setSecretsOpen(true)}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <title>Secrets</title>
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              Secrets
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <RpcConfigSection
              title={t("configpageview.BSC")}
              description="BNB Smart Chain"
              options={BSC_RPC_OPTIONS}
              selectedProvider={selectedBscRpc}
              onSelect={setSelectedBscRpc}
              providerConfigs={bscRpcConfigs}
              rpcFieldValues={rpcFieldValues}
              onRpcFieldChange={handleRpcFieldChange}
              cloud={cloudStatusProps}
              containerClassName="flex flex-wrap gap-1.5"
            />
            <RpcConfigSection
              title={t("configpageview.EVM")}
              description="Ethereum, Base, Arbitrum"
              options={EVM_RPC_OPTIONS}
              selectedProvider={selectedEvmRpc}
              onSelect={setSelectedEvmRpc}
              providerConfigs={evmRpcConfigs}
              rpcFieldValues={rpcFieldValues}
              onRpcFieldChange={handleRpcFieldChange}
              cloud={cloudStatusProps}
              containerClassName="flex flex-wrap gap-1.5"
            />
            <RpcConfigSection
              title={t("configpageview.Solana")}
              description="Solana mainnet"
              options={SOLANA_RPC_OPTIONS}
              selectedProvider={selectedSolanaRpc}
              onSelect={setSelectedSolanaRpc}
              providerConfigs={solanaRpcConfigs}
              rpcFieldValues={rpcFieldValues}
              onRpcFieldChange={handleRpcFieldChange}
              cloud={cloudStatusProps}
              containerClassName="flex flex-wrap gap-1.5"
            />
          </div>

          {legacyRpcWarning && (
            <div className="mt-4 rounded-lg border border-[var(--warn)] bg-[var(--warn-subtle)] px-3 py-2 text-[11px] text-[var(--text)]">
              {legacyRpcWarning}
            </div>
          )}

          <div className="flex justify-end mt-4">
            <button
              type="button"
              className="btn text-[11px] py-1 px-3.5 !mt-0"
              onClick={handleWalletSaveAll}
              disabled={walletApiKeySaving}
            >
              {walletApiKeySaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>
      )}

      {/* ── Secrets modal ── */}
      {secretsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-bg/80"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSecretsOpen(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" || e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setSecretsOpen(false);
            }
          }}
          role="dialog"
          aria-modal="true"
        >
          <div className="w-full max-w-2xl max-h-[80vh] border border-[var(--border)] bg-[var(--card)] p-5 shadow-lg flex flex-col">
            <div className="flex items-center justify-between mb-4 flex-shrink-0">
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
                  className="text-[var(--accent)]"
                >
                  <title>{t("configpageview.SecretsVault")}</title>
                  <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span className="font-bold text-sm">
                  {t("configpageview.SecretsVault1")}
                </span>
              </div>
              <button
                type="button"
                className="text-[var(--muted)] hover:text-[var(--txt)] text-lg leading-none px-1 bg-transparent border-0 cursor-pointer"
                onClick={() => setSecretsOpen(false)}
              >
                {t("bugreportmodal.Times")}
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto">
              <SecretsView />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
