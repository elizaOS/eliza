/**
 * Config page — agent-level configuration.
 *
 * Sections:
 *   1. Wallet & RPC providers
 *   2. Secrets (modal)
 */

import { useCallback, useEffect, useState } from "react";
import { client } from "../api";
import {
  ConfigRenderer,
  defaultRegistry,
  type JsonSchemaObject,
} from "../config";
import { useApp } from "../state";
import type { ConfigUiHint } from "../types";
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

const EVM_RPC_OPTIONS = [
  { id: "eliza-cloud", label: "Eliza Cloud" },
  { id: "alchemy", label: "Alchemy" },
  { id: "infura", label: "Infura" },
  { id: "ankr", label: "Ankr" },
] as const;

const BSC_RPC_OPTIONS = [
  { id: "eliza-cloud", label: "Eliza Cloud" },
  { id: "nodereal", label: "NodeReal" },
  { id: "quicknode", label: "QuickNode" },
] as const;

const SOLANA_RPC_OPTIONS = [
  { id: "eliza-cloud", label: "Eliza Cloud" },
  { id: "helius-birdeye", label: "Helius + Birdeye" },
] as const;

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
        <span className="inline-block w-2 h-2 rounded-full bg-[var(--ok,#16a34a)]" />
        <span className="font-semibold">
          {t("configpageview.ConnectedToElizaC")}
        </span>
        {credits !== null && (
          <span className="text-[var(--muted)] ml-auto">
            {t("configpageview.Credits")}{" "}
            <span
              className={
                creditsCritical
                  ? "text-[var(--danger,#e74c3c)] font-bold"
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
          {t("configpageview.RequiresElizaCloud")}
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
          return key === "elizaclouddashboard.ElizaCloud" ? "Eliza Cloud" : key;
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
                ? "Eliza Cloud"
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
    description:
      "Use Eliza Cloud for LLM calls. Turn off to use your own API keys (Anthropic, OpenAI, etc.)",
  },
  {
    key: "rpc",
    label: "Blockchain RPC",
    description: "Use Eliza Cloud RPC endpoints for EVM, BSC, and Solana",
  },
  {
    key: "media",
    label: "Media Generation",
    description: "Use Eliza Cloud for image, video, audio, and vision",
  },
  {
    key: "tts",
    label: "Text-to-Speech",
    description: "Use Eliza Cloud for TTS voice synthesis",
  },
  {
    key: "embeddings",
    label: "Embeddings",
    description: "Use Eliza Cloud for text embedding generation",
  },
];

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

  // Load current config on mount
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

      // Also set inferenceMode based on inference toggle
      const inferenceMode = updated.inference ? "cloud" : "byok";

      try {
        await client.updateConfig({
          cloud: { services: updated, inferenceMode },
        });
        setNeedsRestart(true);
      } catch (err) {
        // Revert on error
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
    <div className="p-4 border border-[var(--border)] bg-[var(--card)] mt-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-bold text-sm">
          {t("configpageview.CloudServices")}
        </div>
        {needsRestart && (
          <span className="rounded-full border border-[var(--warn)] bg-[var(--warn-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--text)]">
            {t("configpageview.RestartRequiredFor")}
          </span>
        )}
      </div>
      <p className="text-[12px] text-[var(--muted)] mb-4">
        {t("configpageview.ChooseWhichElizaCl")}
      </p>
      <div className="space-y-2">
        {CLOUD_SERVICE_DEFS.map(({ key, label, description }) => (
          <div
            key={key}
            className="flex items-center justify-between p-2.5 border border-[var(--border)] rounded cursor-pointer hover:border-[var(--accent)] transition-colors"
          >
            <div className="flex-1 min-w-0 mr-3">
              <div
                className="text-[13px] font-medium"
                id={`cloud-service-${key}`}
              >
                {label}
              </div>
              <div className="text-[11px] text-[var(--muted)] mt-0.5">
                {description}
              </div>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={services[key]}
              aria-labelledby={`cloud-service-${key}`}
              disabled={saving}
              onClick={() => void handleToggle(key)}
              className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors cursor-pointer ${
                services[key] ? "bg-[var(--accent)]" : "bg-[var(--border)]"
              }`}
            >
              <span
                className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow transform transition-transform ${
                  services[key] ? "translate-x-4" : "translate-x-0"
                }`}
              />
            </button>
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

  const handleWalletSaveAll = useCallback(() => {
    const config: Record<string, string> = {};
    for (const [key, value] of Object.entries(rpcFieldValues)) {
      if (value) config[key] = value;
    }
    void handleWalletApiKeySave(config);
  }, [handleWalletApiKeySave, rpcFieldValues]);

  /* ── RPC provider selection state ──────────────────────────────────── */
  const [selectedEvmRpc, setSelectedEvmRpc] = useState<
    "eliza-cloud" | "alchemy" | "infura" | "ankr"
  >("eliza-cloud");
  const [selectedBscRpc, setSelectedBscRpc] = useState<
    "eliza-cloud" | "nodereal" | "quicknode"
  >("eliza-cloud");
  const [selectedSolanaRpc, setSelectedSolanaRpc] = useState<
    "eliza-cloud" | "helius-birdeye"
  >("eliza-cloud");

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
          1. WALLET & RPC
          ═══════════════════════════════════════════════════════════════ */}
      <div className="p-4 border border-[var(--border)] bg-[var(--card)]">
        <div className="flex items-center justify-between mb-4">
          <div className="font-bold text-sm">
            {t("configpageview.WalletAmpRPC")}
          </div>
          <button
            type="button"
            className="settings-button flex items-center gap-1.5 text-[12px] text-[var(--muted)] hover:text-[var(--txt)] bg-transparent border border-[var(--border)] rounded cursor-pointer transition-colors hover:border-[var(--accent)]"
            onClick={() => setSecretsOpen(true)}
            title={t("configpageview.SecretsVault1")}
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
              <title>{t("configpageview.SecretsVault")}</title>
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>

            {t("configpageview.Secrets")}
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* BSC */}
          <RpcConfigSection
            title={t("configpageview.BSC")}
            description="BNB Smart Chain — trading and market feed"
            options={BSC_RPC_OPTIONS}
            selectedProvider={selectedBscRpc}
            onSelect={setSelectedBscRpc}
            providerConfigs={bscRpcConfigs}
            rpcFieldValues={rpcFieldValues}
            onRpcFieldChange={handleRpcFieldChange}
            cloud={cloudStatusProps}
            containerClassName="grid grid-cols-3 gap-1.5"
          />

          {/* EVM */}
          <RpcConfigSection
            title={t("configpageview.EVM")}
            description="Ethereum, Base, Arbitrum, Optimism, Polygon"
            options={EVM_RPC_OPTIONS}
            selectedProvider={selectedEvmRpc}
            onSelect={setSelectedEvmRpc}
            providerConfigs={evmRpcConfigs}
            rpcFieldValues={rpcFieldValues}
            onRpcFieldChange={handleRpcFieldChange}
            cloud={cloudStatusProps}
            containerClassName="grid grid-cols-4 gap-1.5"
          />

          {/* Solana */}
          <RpcConfigSection
            title={t("configpageview.Solana")}
            description="Solana mainnet tokens and NFTs"
            options={SOLANA_RPC_OPTIONS}
            selectedProvider={selectedSolanaRpc}
            onSelect={setSelectedSolanaRpc}
            providerConfigs={solanaRpcConfigs}
            rpcFieldValues={rpcFieldValues}
            onRpcFieldChange={handleRpcFieldChange}
            cloud={cloudStatusProps}
            containerClassName="grid grid-cols-2 gap-1.5"
          />
        </div>

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

      {/* ═══════════════════════════════════════════════════════════════
          2. CLOUD SERVICES
          ═══════════════════════════════════════════════════════════════ */}
      {elizaCloudConnected && <CloudServicesSection />}

      {/* ── Secrets modal ── */}
      {secretsOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
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
