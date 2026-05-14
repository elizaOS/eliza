/**
 * Sub-components and helpers for ConfigPageView.
 * Extracted from ConfigPageView.tsx.
 */

import {
  normalizeOnboardingProviderId,
  WALLET_RPC_PROVIDER_OPTIONS,
} from "@elizaos/shared";
import { useCallback, useEffect, useState } from "react";
import { client } from "../../api";
import {
  ConfigRenderer,
  defaultRegistry,
} from "../../components/config-ui/config-renderer";
import type { JsonSchemaObject } from "../../config/config-catalog";
import { useApp } from "../../state";
import type { TranslateFn as AppTranslateFn, ConfigUiHint } from "../../types";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

/* ── Types ─────────────────────────────────────────────────────────── */

export type RpcProviderOption<T extends string> = {
  id: T;
  label: string;
};

export type TranslateOptions = Record<string, unknown>;

export type TranslateFn = AppTranslateFn;

export type RpcFieldDefinition = {
  configKey: string;
  label: string;
  isSet: boolean;
};

export type RpcFieldGroup = ReadonlyArray<RpcFieldDefinition>;

export type RpcSectionConfigMap = Record<string, RpcFieldGroup>;

/* ── Constants ─────────────────────────────────────────────────────── */

export const EVM_RPC_OPTIONS = WALLET_RPC_PROVIDER_OPTIONS.evm;
export const BSC_RPC_OPTIONS = WALLET_RPC_PROVIDER_OPTIONS.bsc;
export const SOLANA_RPC_OPTIONS = WALLET_RPC_PROVIDER_OPTIONS.solana;

/* ── CloudRpcStatus ────────────────────────────────────────────────── */

export type CloudRpcStatusProps = {
  connected: boolean;
  loginBusy: boolean;
  onLogin: () => void;
};

export function CloudRpcStatus({
  connected,
  loginBusy,
  onLogin,
}: CloudRpcStatusProps) {
  const { t } = useApp();
  if (connected) {
    return null;
  }

  return (
    <div className="flex justify-start">
      <Button
        variant="default"
        size="sm"
        className="text-xs font-bold"
        onClick={() => void onLogin()}
        disabled={loginBusy}
      >
        {loginBusy
          ? t("game.connecting", { defaultValue: "Connecting..." })
          : t("elizaclouddashboard.ConnectElizaCloud", {
              defaultValue: "Connect to Eliza Cloud",
            })}
      </Button>
    </div>
  );
}

/* ── buildRpcRendererConfig ────────────────────────────────────────── */

export function buildRpcRendererConfig(
  t: TranslateFn,
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
        ? t("configpageview.ApiKeySetPlaceholder", {
            defaultValue: "Already set — leave blank to keep",
          })
        : t("configpageview.ApiKeyPlaceholder", {
            defaultValue: "Enter API key",
          }),
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

/* ── RpcConfigSection ──────────────────────────────────────────────── */

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
  t: TranslateFn;
};

export function RpcConfigSection<T extends string>({
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
  t,
}: RpcSectionProps<T>) {
  const rpcConfig = buildRpcRendererConfig(
    t,
    selectedProvider,
    providerConfigs,
    rpcFieldValues,
  );

  return (
    <div>
      <div className="text-xs font-bold mb-1">{title}</div>
      <div className="text-xs-tight text-muted mb-2">{description}</div>

      {renderRpcProviderButtons(
        options,
        selectedProvider,
        onSelect,
        containerClassName,
        (key: string) => {
          // hack to get t function without breaking hook rules
          return key === "providerswitcher.elizaCloud"
            ? t("common.cloud", { defaultValue: "Eliza Cloud" })
            : key;
        },
      )}

      <div className="mt-3">
        {selectedProvider === "eliza-cloud" ? (
          <CloudRpcStatus
            connected={cloud.connected}
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

/* ── renderRpcProviderButtons ──────────────────────────────────────── */

export function renderRpcProviderButtons<T extends string>(
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
          <Button
            variant={active ? "default" : "outline"}
            key={provider.id}
            className={`flex min-h-touch items-center justify-center rounded-lg px-3 py-2 text-center text-xs font-semibold leading-tight shadow-sm ${
              active
                ? ""
                : "border-border bg-card text-txt hover:border-accent hover:bg-bg-hover"
            }`}
            onClick={() => onSelect(provider.id)}
          >
            <div className="leading-tight">
              {provider.id === "eliza-cloud" && tFallback
                ? tFallback("providerswitcher.elizaCloud")
                : provider.label}
            </div>
          </Button>
        );
      })}
    </div>
  );
}

/* ── Cloud services toggle section ───────────────────────────────────── */

type CloudServiceKey = "rpc" | "media" | "tts" | "embeddings";

const CLOUD_SERVICE_DEFS: {
  key: CloudServiceKey;
  labelKey: string;
  labelDefault: string;
  descriptionKey: string;
  descriptionDefault: string;
}[] = [
  {
    key: "rpc",
    labelKey: "configpageview.ServiceRpcLabel",
    labelDefault: "RPC",
    descriptionKey: "configpageview.ServiceRpcDesc",
    descriptionDefault:
      "Remote procedure calls for agent coordination and messaging.",
  },
  {
    key: "media",
    labelKey: "configpageview.ServiceMediaLabel",
    labelDefault: "Media",
    descriptionKey: "configpageview.ServiceMediaDesc",
    descriptionDefault:
      "Cloud media processing for images, video, and file conversion.",
  },
  {
    key: "tts",
    labelKey: "configpageview.ServiceTtsLabel",
    labelDefault: "Text-to-Speech",
    descriptionKey: "configpageview.ServiceTtsDesc",
    descriptionDefault: "Cloud-hosted voice synthesis for agent speech output.",
  },
  {
    key: "embeddings",
    labelKey: "configpageview.ServiceEmbeddingsLabel",
    labelDefault: "Embeddings",
    descriptionKey: "configpageview.ServiceEmbeddingsDesc",
    descriptionDefault:
      "Cloud-hosted embedding models for knowledge search and memory.",
  },
];

function isCloudServiceRouteSelected(route: unknown): boolean {
  if (!route || typeof route !== "object" || Array.isArray(route)) {
    return false;
  }
  const routeRecord = route as Record<string, unknown>;
  return (
    routeRecord.transport === "cloud-proxy" &&
    normalizeOnboardingProviderId(routeRecord.backend) === "elizacloud"
  );
}

export function CloudServicesSection() {
  const { t } = useApp();
  const [services, setServices] = useState<Record<CloudServiceKey, boolean>>({
    rpc: false,
    media: false,
    tts: false,
    embeddings: false,
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
        const routing =
          cfg.serviceRouting &&
          typeof cfg.serviceRouting === "object" &&
          !Array.isArray(cfg.serviceRouting)
            ? (cfg.serviceRouting as Record<string, unknown>)
            : {};
        setServices({
          rpc: isCloudServiceRouteSelected(routing.rpc),
          media: isCloudServiceRouteSelected(routing.media),
          tts: isCloudServiceRouteSelected(routing.tts),
          embeddings: isCloudServiceRouteSelected(routing.embeddings),
        });
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
      try {
        const cfg = await client.getConfig();
        const existingRouting =
          cfg.serviceRouting &&
          typeof cfg.serviceRouting === "object" &&
          !Array.isArray(cfg.serviceRouting)
            ? (cfg.serviceRouting as Record<string, unknown>)
            : {};
        await client.updateConfig({
          serviceRouting: {
            ...existingRouting,
            [key]: newValue
              ? {
                  backend: "elizacloud",
                  transport: "cloud-proxy",
                  accountId: "elizacloud",
                }
              : null,
          },
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
    <div className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold">
          {t("configpageview.CloudServices", {
            defaultValue: "Cloud Services",
          })}
        </div>
        {needsRestart && (
          <span className="text-xs-tight font-medium px-2.5 py-0.5 rounded-full border border-accent/30 bg-accent/8 text-accent">
            {t("configpageview.RestartRequired", {
              defaultValue: "Restart required",
            })}
          </span>
        )}
      </div>
      <p className="text-xs text-muted mb-4 leading-snug">
        {t("configpageview.CloudServicesDesc", {
          defaultValue: "Toggle Eliza Cloud services",
        })}
      </p>
      <div className="flex flex-col gap-2">
        {CLOUD_SERVICE_DEFS.map(
          ({
            key,
            labelKey,
            labelDefault,
            descriptionKey,
            descriptionDefault,
          }) => (
            <div
              key={key}
              className={`flex items-center justify-between p-3 border border-border rounded-lg transition-colors ${
                services[key] ? "bg-accent/5" : ""
              }`}
            >
              <div className="flex-1 min-w-0 mr-4">
                <div
                  id={`cloud-service-${key}`}
                  className="text-sm font-medium text-txt"
                >
                  {t(labelKey, { defaultValue: labelDefault })}
                </div>
                <div className="text-xs-tight text-muted mt-0.5">
                  {t(descriptionKey, { defaultValue: descriptionDefault })}
                </div>
              </div>
              <Switch
                checked={services[key]}
                disabled={saving}
                onCheckedChange={() => void handleToggle(key)}
                aria-labelledby={`cloud-service-${key}`}
              />
            </div>
          ),
        )}
      </div>
    </div>
  );
}
