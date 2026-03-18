/**
 * ProviderSwitcher — Provider grid, cloud settings, and switching logic.
 *
 * Extracted from SettingsView.tsx for decomposition (P2 §10).
 * Composes SubscriptionStatus and ApiKeyConfig sub-components.
 */

import { Button, Input } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { client, type OnboardingOptions, type PluginParamDef } from "../api";
import {
  ConfigRenderer,
  defaultRegistry,
  type JsonSchemaObject,
} from "../config";
import { useTimeout } from "../hooks";
import {
  getOnboardingProviderOption,
  getStoredSubscriptionProvider,
  getSubscriptionProviderFamily,
  isSubscriptionProviderSelectionId,
  normalizeSubscriptionProviderSelectionId,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  type SubscriptionProviderSelectionId,
} from "../providers";
import { useApp } from "../state";
import type { ConfigUiHint } from "../types";
import { ApiKeyConfig } from "./ApiKeyConfig";
import { SubscriptionStatus } from "./SubscriptionStatus";

interface PluginInfo {
  id: string;
  name: string;
  category: string;
  enabled: boolean;
  configured: boolean;
  parameters: PluginParamDef[];
  configUiHints?: Record<string, ConfigUiHint>;
}

function normalizeAiProviderPluginId(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "");
}

interface ProviderSwitcherProps {
  elizaCloudEnabled?: boolean;
  elizaCloudConnected?: boolean;
  elizaCloudCredits?: number | null;
  elizaCloudCreditsLow?: boolean;
  elizaCloudCreditsCritical?: boolean;
  elizaCloudTopUpUrl?: string;
  elizaCloudUserId?: string | null;
  elizaCloudLoginBusy?: boolean;
  elizaCloudLoginError?: string | null;
  cloudDisconnecting?: boolean;
  plugins?: PluginInfo[];
  pluginSaving?: Set<string>;
  pluginSaveSuccess?: Set<string>;
  loadPlugins?: () => Promise<void>;
  handlePluginToggle?: (pluginId: string, enabled: boolean) => Promise<void>;
  handlePluginConfigSave?: (
    pluginId: string,
    values: Record<string, unknown>,
  ) => void | Promise<void>;
  handleCloudLogin?: () => Promise<void>;
  handleCloudDisconnect?: () => Promise<void>;
  setState?: (key: string, value: unknown) => void;
  setTab?: (tab: string) => void;
}

export function ProviderSwitcher(props: ProviderSwitcherProps = {}) {
  const { setTimeout } = useTimeout();
  const app = useApp();
  const t = app.t;
  const elizaCloudEnabled =
    props.elizaCloudEnabled ?? Boolean(app.elizaCloudEnabled);
  const elizaCloudConnected =
    props.elizaCloudConnected ?? Boolean(app.elizaCloudConnected);
  const elizaCloudCredits = props.elizaCloudCredits ?? app.elizaCloudCredits;
  const elizaCloudCreditsLow =
    props.elizaCloudCreditsLow ?? Boolean(app.elizaCloudCreditsLow);
  const elizaCloudCreditsCritical =
    props.elizaCloudCreditsCritical ?? Boolean(app.elizaCloudCreditsCritical);
  const elizaCloudUserId =
    props.elizaCloudUserId ??
    (typeof app.elizaCloudUserId === "string" ? app.elizaCloudUserId : null);
  const elizaCloudLoginBusy =
    props.elizaCloudLoginBusy ?? Boolean(app.elizaCloudLoginBusy);
  const elizaCloudLoginError =
    props.elizaCloudLoginError ??
    (typeof app.elizaCloudLoginError === "string"
      ? app.elizaCloudLoginError
      : null);
  const cloudDisconnecting =
    props.cloudDisconnecting ?? Boolean(app.elizaCloudDisconnecting);
  const plugins = Array.isArray(props.plugins)
    ? props.plugins
    : Array.isArray(app.plugins)
      ? app.plugins
      : [];
  const pluginSaving =
    props.pluginSaving ??
    (app.pluginSaving instanceof Set ? app.pluginSaving : new Set<string>());
  const pluginSaveSuccess =
    props.pluginSaveSuccess ??
    (app.pluginSaveSuccess instanceof Set
      ? app.pluginSaveSuccess
      : new Set<string>());
  const loadPlugins = props.loadPlugins ?? app.loadPlugins;
  const handlePluginToggle = props.handlePluginToggle ?? app.handlePluginToggle;
  const handlePluginConfigSave =
    props.handlePluginConfigSave ?? app.handlePluginConfigSave;
  const handleCloudLogin = props.handleCloudLogin ?? app.handleCloudLogin;
  const handleCloudDisconnect =
    props.handleCloudDisconnect ?? app.handleCloudDisconnect;
  const setState = props.setState ?? app.setState;
  const setTab = props.setTab ?? app.setTab;
  /* ── Model selection state ─────────────────────────────────────── */
  const [modelOptions, setModelOptions] = useState<
    OnboardingOptions["models"] | null
  >(null);
  const [currentSmallModel, setCurrentSmallModel] = useState("");
  const [currentLargeModel, setCurrentLargeModel] = useState("");
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSaveSuccess, setModelSaveSuccess] = useState(false);

  /* ── Subscription state ────────────────────────────────────────── */
  const [subscriptionStatus, setSubscriptionStatus] = useState<
    Array<{
      provider: string;
      configured: boolean;
      valid: boolean;
      expiresAt: number | null;
    }>
  >([]);
  const [anthropicConnected, setAnthropicConnected] = useState(false);
  const [openaiConnected, setOpenaiConnected] = useState(false);

  /* ── Cloud inference state ─────────────────────────────────────── */
  const [cloudHandlesInference, setCloudHandlesInference] = useState(false);

  /* ── pi-ai state ──────────────────────────────────────────────── */
  const [piAiEnabled, setPiAiEnabled] = useState(false);
  const [piAiModelSpec, setPiAiModelSpec] = useState("");
  const [piAiModelOptions, setPiAiModelOptions] = useState<
    OnboardingOptions["piAiModels"]
  >([]);
  const [piAiDefaultModelSpec, setPiAiDefaultModelSpec] = useState("");
  const [piAiSaving, setPiAiSaving] = useState(false);
  const [piAiSaveSuccess, setPiAiSaveSuccess] = useState(false);

  const loadSubscriptionStatus = useCallback(async () => {
    try {
      const res = await client.getSubscriptionStatus();
      setSubscriptionStatus(res.providers ?? []);
    } catch (err) {
      console.warn("[eliza] Failed to load subscription status", err);
    }
  }, []);

  useEffect(() => {
    void loadSubscriptionStatus();
    void (async () => {
      try {
        const opts = await client.getOnboardingOptions();
        setModelOptions(opts.models);
        setPiAiModelOptions(opts.piAiModels ?? []);
        setPiAiDefaultModelSpec(
          typeof opts.piAiDefaultModel === "string"
            ? opts.piAiDefaultModel
            : "",
        );
      } catch (err) {
        console.warn("[eliza] Failed to load onboarding options", err);
      }
      try {
        const cfg = await client.getConfig();
        const models = cfg.models as Record<string, string> | undefined;
        const cloud = cfg.cloud as Record<string, unknown> | undefined;
        const elizaCloudEnabledCfg = cloud?.enabled === true;
        const defaultSmall = "moonshotai/kimi-k2-turbo";
        const defaultLarge = "moonshotai/kimi-k2-0905";

        // Environment variables — needed both for model fallback and pi-ai
        const env = cfg.env as Record<string, unknown> | undefined;
        const vars = (env?.vars as Record<string, unknown> | undefined) ?? {};

        // Fall back to SMALL_MODEL / LARGE_MODEL env vars when cfg.models
        // is empty.  Local providers (e.g. Ollama) store the active model
        // names as env vars rather than in cfg.models.
        const envSmall =
          typeof vars.SMALL_MODEL === "string" ? vars.SMALL_MODEL : "";
        const envLarge =
          typeof vars.LARGE_MODEL === "string" ? vars.LARGE_MODEL : "";
        setCurrentSmallModel(
          models?.small ||
            envSmall ||
            (elizaCloudEnabledCfg ? defaultSmall : ""),
        );
        setCurrentLargeModel(
          models?.large ||
            envLarge ||
            (elizaCloudEnabledCfg ? defaultLarge : ""),
        );
        const rawPiAi =
          (typeof vars.ELIZA_USE_PI_AI === "string"
            ? vars.ELIZA_USE_PI_AI
            : undefined) ||
          (typeof env?.ELIZA_USE_PI_AI === "string" ? env.ELIZA_USE_PI_AI : "");
        const piAiOn = ["1", "true", "yes"].includes(
          rawPiAi.trim().toLowerCase(),
        );
        setPiAiEnabled(piAiOn);

        // Check if cloud handles inference or user has own keys
        const cloudServices = cloud?.services as
          | Record<string, unknown>
          | undefined;
        const inferenceMode =
          typeof cloud?.inferenceMode === "string"
            ? cloud.inferenceMode
            : "cloud";
        const inferenceToggle = cloudServices?.inference !== false;
        const cloudHandlesInferenceCfg =
          elizaCloudEnabledCfg && inferenceMode === "cloud" && inferenceToggle;
        setCloudHandlesInference(cloudHandlesInferenceCfg);

        const agents = cfg.agents as Record<string, unknown> | undefined;
        const defaults = agents?.defaults as
          | Record<string, unknown>
          | undefined;
        const model = defaults?.model as Record<string, unknown> | undefined;
        const savedSubscriptionProvider =
          normalizeSubscriptionProviderSelectionId(
            defaults?.subscriptionProvider,
          );
        setPiAiModelSpec(
          typeof model?.primary === "string" ? model.primary : "",
        );
        if (
          !hasManualSelection.current &&
          savedSubscriptionProvider &&
          !piAiOn &&
          !cloudHandlesInferenceCfg
        ) {
          setSelectedProviderId(savedSubscriptionProvider);
        }
      } catch (err) {
        console.warn("[eliza] Failed to load config", err);
      }
    })();
  }, [loadSubscriptionStatus]);

  useEffect(() => {
    const anthStatus = subscriptionStatus.find(
      (s) => s.provider === "anthropic-subscription",
    );
    const oaiStatus = subscriptionStatus.find(
      (s) =>
        s.provider === "openai-subscription" || s.provider === "openai-codex",
    );
    setAnthropicConnected(Boolean(anthStatus?.configured && anthStatus?.valid));
    setOpenaiConnected(Boolean(oaiStatus?.configured && oaiStatus?.valid));
  }, [subscriptionStatus]);

  /* ── Derived ──────────────────────────────────────────────────── */
  const allAiProviders = [
    ...plugins.filter((p) => p.category === "ai-provider"),
  ].sort((left, right) => {
    const leftCatalog = getOnboardingProviderOption(
      normalizeAiProviderPluginId(left.id),
    );
    const rightCatalog = getOnboardingProviderOption(
      normalizeAiProviderPluginId(right.id),
    );
    if (leftCatalog && rightCatalog) {
      return leftCatalog.order - rightCatalog.order;
    }
    if (leftCatalog) return -1;
    if (rightCatalog) return 1;
    return left.name.localeCompare(right.name);
  });
  const enabledAiProviders = allAiProviders.filter((p) => p.enabled);

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    () => (elizaCloudEnabled ? "__cloud__" : null),
  );
  const hasManualSelection = useRef(false);

  useEffect(() => {
    if (hasManualSelection.current) return;
    if (piAiEnabled) {
      if (selectedProviderId !== "pi-ai") setSelectedProviderId("pi-ai");
      return;
    }
    // Only auto-select cloud if cloud handles inference (not just enabled)
    if (cloudHandlesInference) {
      if (selectedProviderId !== "__cloud__")
        setSelectedProviderId("__cloud__");
    }
  }, [cloudHandlesInference, piAiEnabled, selectedProviderId]);

  const resolvedSelectedId =
    selectedProviderId === "__cloud__"
      ? "__cloud__"
      : selectedProviderId === "pi-ai"
        ? "pi-ai"
        : selectedProviderId &&
            (allAiProviders.some((p) => p.id === selectedProviderId) ||
              isSubscriptionProviderSelectionId(selectedProviderId))
          ? selectedProviderId
          : cloudHandlesInference
            ? "__cloud__"
            : piAiEnabled
              ? "pi-ai"
              : anthropicConnected
                ? "anthropic-subscription"
                : openaiConnected
                  ? "openai-subscription"
                  : (enabledAiProviders[0]?.id ?? null);

  const selectedProvider =
    resolvedSelectedId &&
    resolvedSelectedId !== "__cloud__" &&
    resolvedSelectedId !== "pi-ai" &&
    !isSubscriptionProviderSelectionId(resolvedSelectedId)
      ? (allAiProviders.find((p) => p.id === resolvedSelectedId) ?? null)
      : null;

  /* ── Handlers ─────────────────────────────────────────────────── */
  const handleSwitchProvider = useCallback(
    async (newId: string) => {
      hasManualSelection.current = true;
      setSelectedProviderId(newId);
      const target = allAiProviders.find((p) => p.id === newId);
      if (!target) return;

      // Direct providers require API keys. The UI does not have access to stored
      // secrets, so we avoid calling /api/provider/switch here and instead rely
      // on enabling/disabling provider plugins + saving provider config.
      const willTogglePlugins =
        !target.enabled || enabledAiProviders.some((p) => p.id !== newId);
      if (elizaCloudEnabled || piAiEnabled) {
        try {
          // Disable cloud inference and explicitly mark cloud as disabled
          // so the cloud-status check doesn't re-enable it on restart.
          await client.updateConfig({
            cloud: {
              enabled: false,
              services: { inference: false },
              inferenceMode: "byok",
            },
            env: { vars: { ELIZA_USE_PI_AI: "" } },
          });
          setPiAiEnabled(false);
          setCloudHandlesInference(false);
          if (!willTogglePlugins) {
            await client.restartAgent();
          }
        } catch (err) {
          console.warn(
            "[eliza] Failed to update cloud inference config during provider switch",
            err,
          );
        }
      }
      if (!target.enabled) {
        await handlePluginToggle(newId, true);
      }
      for (const p of enabledAiProviders) {
        if (p.id !== newId) {
          await handlePluginToggle(p.id, false);
        }
      }
    },
    [
      allAiProviders,
      enabledAiProviders,
      handlePluginToggle,
      elizaCloudEnabled,
      piAiEnabled,
    ],
  );

  const handleSelectSubscription = useCallback(
    async (providerId: SubscriptionProviderSelectionId) => {
      hasManualSelection.current = true;
      setSelectedProviderId(providerId);
      const providerFamily = getSubscriptionProviderFamily(providerId);
      const target =
        allAiProviders.find((plugin) => {
          const normalizedId = normalizeAiProviderPluginId(plugin.id);
          const normalizedName = plugin.name.toLowerCase();
          return (
            normalizedId === providerFamily ||
            normalizedId.startsWith(`${providerFamily}-`) ||
            normalizedName.includes(providerFamily)
          );
        }) ?? null;

      try {
        // Disable cloud inference but keep cloud connected for RPC/services
        await client.updateConfig({
          cloud: {
            services: { inference: false },
            inferenceMode: "byok",
          },
          env: { vars: { ELIZA_USE_PI_AI: "" } },
        });
        await client.switchProvider(getStoredSubscriptionProvider(providerId));
        setCloudHandlesInference(false);
        setPiAiEnabled(false);
      } catch (err) {
        console.warn("[eliza] Provider switch failed", err);
      }
      if (target && !target.enabled) {
        await handlePluginToggle(target.id, true);
      }
      for (const p of enabledAiProviders) {
        if (!target || p.id !== target.id) {
          await handlePluginToggle(p.id, false);
        }
      }
    },
    [allAiProviders, enabledAiProviders, handlePluginToggle],
  );

  const handleSelectCloud = useCallback(async () => {
    hasManualSelection.current = true;
    setSelectedProviderId("__cloud__");
    try {
      await client.updateConfig({
        cloud: {
          enabled: true,
          services: { inference: true },
          inferenceMode: "cloud",
        },
        env: { vars: { ELIZA_USE_PI_AI: "" } },
        agents: { defaults: { model: { primary: null } } },
        models: {
          small: currentSmallModel || "moonshotai/kimi-k2-turbo",
          large: currentLargeModel || "moonshotai/kimi-k2-0905",
        },
      });
      setState("elizaCloudEnabled", true);
      setCloudHandlesInference(true);
      setPiAiEnabled(false);
      await client.restartAgent();
    } catch (err) {
      console.warn("[eliza] Failed to select cloud provider", err);
    }
  }, [currentSmallModel, currentLargeModel, setState]);

  const handlePiAiSave = useCallback(async () => {
    setPiAiSaving(true);
    setPiAiSaveSuccess(false);
    try {
      await client.updateConfig({
        cloud: {
          enabled: false,
          services: { inference: false },
          inferenceMode: "byok",
        },
        env: { vars: { ELIZA_USE_PI_AI: "1" } },
        agents: {
          defaults: {
            model: {
              primary: piAiModelSpec.trim() || null,
            },
          },
        },
      });
      setPiAiEnabled(true);
      setPiAiSaveSuccess(true);
      setTimeout(() => setPiAiSaveSuccess(false), 2000);
      await client.restartAgent();
    } catch (err) {
      console.warn("[eliza] Failed to enable pi-ai", err);
    } finally {
      setPiAiSaving(false);
    }
  }, [piAiModelSpec, setTimeout]);

  const handleSelectPiAi = useCallback(async () => {
    hasManualSelection.current = true;
    setSelectedProviderId("pi-ai");
    await handlePiAiSave();
  }, [handlePiAiSave]);

  const normalizedPiAiModelSpec = piAiModelSpec.trim();
  const hasKnownPiAiModel = (piAiModelOptions ?? []).some(
    (model) => model.id === normalizedPiAiModelSpec,
  );
  const piAiModelSelectValue =
    normalizedPiAiModelSpec.length === 0
      ? ""
      : hasKnownPiAiModel
        ? normalizedPiAiModelSpec
        : "__custom__";

  /* ── Render ───────────────────────────────────────────────────── */
  const totalCols =
    allAiProviders.length + 2 + SUBSCRIPTION_PROVIDER_SELECTIONS.length;
  const isCloudSelected = resolvedSelectedId === "__cloud__";
  const isPiAiSelected = resolvedSelectedId === "pi-ai";
  const isSubscriptionSelected =
    isSubscriptionProviderSelectionId(resolvedSelectedId);
  const providerChoices = [
    {
      id: "__cloud__",
      label: t("providerswitcher.elizaCloud"),
      disabled: false,
    },
    { id: "pi-ai", label: t("providerswitcher.piAi"), disabled: false },
    ...SUBSCRIPTION_PROVIDER_SELECTIONS.map((provider) => ({
      id: provider.id,
      label: t(provider.labelKey),
      disabled: false,
    })),
    ...allAiProviders.map((provider) => ({
      id: provider.id,
      label:
        getOnboardingProviderOption(normalizeAiProviderPluginId(provider.id))
          ?.name ?? provider.name,
      disabled: false,
    })),
  ];

  if (totalCols === 0) {
    return (
      <div className="p-4 border border-[var(--warning,#f39c12)] bg-[var(--card)]">
        <div className="text-xs text-[var(--warning,#f39c12)]">
          {t("providerswitcher.noAiProvidersAvailable")}{" "}
          <Button
            variant="link"
            size="sm"
            className="settings-compact-button text-txt underline p-0 h-auto"
            onClick={() => {
              setTab("plugins");
            }}
          >
            {t("providerswitcher.plugins")}
          </Button>{" "}
          {t("providerswitcher.page")}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Provider dropdown - works for all screen sizes */}
      <div className="mb-3">
        <label
          htmlFor="provider-switcher-select"
          className="block text-xs font-semibold mb-1.5 text-[var(--muted)]"
        >
          {t("providerswitcher.selectAIProvider")}
        </label>
        <select
          id="provider-switcher-select"
          className="w-full px-3 pr-8 py-2.5 border border-[var(--border)] bg-[var(--card)] text-[13px] rounded-lg transition-all duration-200 focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 focus:outline-none hover:border-[var(--border-hover)]"
          value={resolvedSelectedId ?? "__cloud__"}
          onChange={(e) => {
            const nextId = e.target.value;
            if (nextId === "__cloud__") {
              void handleSelectCloud();
              return;
            }
            if (nextId === "pi-ai") {
              void handleSelectPiAi();
              return;
            }
            if (isSubscriptionProviderSelectionId(nextId)) {
              void handleSelectSubscription(nextId);
              return;
            }
            void handleSwitchProvider(nextId);
          }}
        >
          {providerChoices.map((choice) => (
            <option
              key={choice.id}
              value={choice.id}
              disabled={choice.disabled}
            >
              {choice.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-[var(--muted)] mt-1.5">
          {t("providerswitcher.chooseYourPreferredProvider")}
        </p>
      </div>

      {/* Cloud settings */}
      {isCloudSelected && (
        <div className="mt-4 pt-4 border-t border-[var(--border)]">
          {elizaCloudConnected ? (
            <div>
              <div className="flex justify-between items-center mb-3">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-[var(--ok,#16a34a)]" />
                  <span className="text-xs font-semibold">
                    {t("providerswitcher.loggedIntoElizaCloud")}
                  </span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="!mt-0"
                  onClick={() => void handleCloudDisconnect()}
                  disabled={cloudDisconnecting}
                >
                  {cloudDisconnecting
                    ? t("providerswitcher.disconnecting")
                    : t("providerswitcher.disconnect")}
                </Button>
              </div>

              <div className="text-xs mb-4">
                {elizaCloudUserId && (
                  <span className="text-[var(--muted)] mr-3">
                    <code className="font-[var(--mono)] text-[11px]">
                      {elizaCloudUserId}
                    </code>
                  </span>
                )}
                {elizaCloudCredits !== null && (
                  <span>
                    <span className="text-[var(--muted)]">
                      {t("providerswitcher.credits")}
                    </span>{" "}
                    <span
                      className={
                        elizaCloudCreditsCritical
                          ? "text-[var(--danger,#e74c3c)] font-bold"
                          : elizaCloudCreditsLow
                            ? "rounded-md bg-[var(--warn-subtle)] px-1.5 py-0.5 text-[var(--text)] font-bold"
                            : ""
                      }
                    >
                      ${elizaCloudCredits.toFixed(2)}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setState("cloudDashboardView", "billing");
                        setTab("settings");
                      }}
                      className="ml-2 bg-transparent border-0 p-0 cursor-pointer text-[11px] text-[var(--text)] underline decoration-[var(--accent)] underline-offset-2 hover:opacity-80"
                    >
                      {t("providerswitcher.topUp")}
                    </button>
                  </span>
                )}
              </div>

              {modelOptions &&
                (() => {
                  const modelSchema = {
                    type: "object" as const,
                    properties: {
                      small: {
                        type: "string",
                        enum: modelOptions.small.map((m) => m.id),
                        description: t(
                          "providerswitcher.smallModelDescription",
                        ),
                      },
                      large: {
                        type: "string",
                        enum: modelOptions.large.map((m) => m.id),
                        description: t(
                          "providerswitcher.largeModelDescription",
                        ),
                      },
                    },
                    required: [] as string[],
                  };
                  const modelHints: Record<string, ConfigUiHint> = {
                    small: {
                      label: t("providerswitcher.smallModelLabel"),
                      width: "half",
                    },
                    large: {
                      label: t("providerswitcher.largeModelLabel"),
                      width: "half",
                    },
                  };
                  const modelValues: Record<string, unknown> = {};
                  const modelSetKeys = new Set<string>();
                  if (currentSmallModel) {
                    modelValues.small = currentSmallModel;
                    modelSetKeys.add("small");
                  }
                  if (currentLargeModel) {
                    modelValues.large = currentLargeModel;
                    modelSetKeys.add("large");
                  }

                  return (
                    <ConfigRenderer
                      schema={modelSchema as JsonSchemaObject}
                      hints={modelHints}
                      values={modelValues}
                      setKeys={modelSetKeys}
                      registry={defaultRegistry}
                      onChange={(key, value) => {
                        const val = String(value);
                        if (key === "small") setCurrentSmallModel(val);
                        if (key === "large") setCurrentLargeModel(val);
                        const updated = {
                          small: key === "small" ? val : currentSmallModel,
                          large: key === "large" ? val : currentLargeModel,
                        };
                        void (async () => {
                          setModelSaving(true);
                          try {
                            await client.updateConfig({ models: updated });
                            setModelSaveSuccess(true);
                            setTimeout(() => setModelSaveSuccess(false), 2000);
                            await client.restartAgent();
                          } catch (err) {
                            console.warn(
                              "[eliza] Failed to save cloud model config",
                              err,
                            );
                          }
                          setModelSaving(false);
                        })();
                      }}
                    />
                  );
                })()}

              <div className="flex items-center justify-end gap-2 mt-3">
                {modelSaving && (
                  <span className="text-[11px] text-[var(--muted)]">
                    {t("providerswitcher.savingRestarting")}
                  </span>
                )}
                {modelSaveSuccess && (
                  <span className="text-[11px] text-[var(--ok,#16a34a)]">
                    {t("providerswitcher.savedRestartingAgent")}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div>
              {elizaCloudLoginBusy ? (
                <div className="text-xs text-[var(--muted)]">
                  {t("providerswitcher.waitingForBrowser")}
                </div>
              ) : (
                <>
                  {elizaCloudLoginError && (
                    <div className="text-xs text-[var(--danger,#e74c3c)] mb-2">
                      {elizaCloudLoginError}
                    </div>
                  )}
                  <Button
                    variant="default"
                    size="sm"
                    className="!mt-0 font-bold"
                    onClick={() => void handleCloudLogin()}
                  >
                    {t("providerswitcher.logInToElizaCloud")}
                  </Button>
                  <div className="text-[11px] text-[var(--muted)] mt-1.5">
                    {t("providerswitcher.opensABrowserWindow")}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {/* Subscription provider settings */}
      {isSubscriptionSelected && (
        <SubscriptionStatus
          resolvedSelectedId={resolvedSelectedId}
          subscriptionStatus={subscriptionStatus}
          anthropicConnected={anthropicConnected}
          setAnthropicConnected={setAnthropicConnected}
          openaiConnected={openaiConnected}
          setOpenaiConnected={setOpenaiConnected}
          handleSelectSubscription={handleSelectSubscription}
          loadSubscriptionStatus={loadSubscriptionStatus}
        />
      )}

      {/* pi-ai settings */}
      {!isCloudSelected && isPiAiSelected && (
        <div className="mt-4 pt-4 border-t border-[var(--border)]">
          <div className="text-xs font-semibold mb-2">
            {t("providerswitcher.piSettings")}
          </div>
          <div className="text-[11px] text-[var(--muted)] mb-2">
            {t("providerswitcher.usesLocalCredentials")}
          </div>
          <label
            htmlFor="pi-ai-model-override"
            className="block text-[11px] text-[var(--muted)] mb-1"
          >
            {t("providerswitcher.primaryModelOverride")}
          </label>

          {piAiModelOptions && piAiModelOptions.length > 0 ? (
            <>
              <select
                id="pi-ai-model-override"
                value={piAiModelSelectValue}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next === "__custom__") {
                    if (piAiModelSelectValue !== "__custom__") {
                      setPiAiModelSpec("");
                    }
                    return;
                  }
                  setPiAiModelSpec(next);
                }}
                className="w-full px-2.5 py-[8px] border border-[var(--border)] bg-[var(--card)] text-[13px] transition-colors focus:border-[var(--accent)] focus:outline-none"
              >
                <option value="">
                  {t("providerswitcher.usePiDefaultModel")}
                  {piAiDefaultModelSpec ? ` (${piAiDefaultModelSpec})` : ""}
                </option>
                {piAiModelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name} ({model.provider})
                  </option>
                ))}
                <option value="__custom__">
                  {t("providerswitcher.customModelSpec")}
                </option>
              </select>

              {piAiModelSelectValue === "__custom__" && (
                <Input
                  type="text"
                  value={piAiModelSpec}
                  onChange={(e) => setPiAiModelSpec(e.target.value)}
                  placeholder={t("providerswitcher.providerModelPlaceholder")}
                  className="mt-2 bg-card text-[13px]"
                />
              )}
            </>
          ) : (
            <Input
              id="pi-ai-model-override"
              type="text"
              value={piAiModelSpec}
              onChange={(e) => setPiAiModelSpec(e.target.value)}
              placeholder={t("providerswitcher.providerModelPlaceholder")}
              className="bg-card text-[13px]"
            />
          )}
          <div className="flex items-center justify-end gap-2 mt-3">
            {piAiSaving && (
              <span className="text-[11px] text-[var(--muted)]">
                {t("providerswitcher.savingRestarting")}
              </span>
            )}
            {piAiSaveSuccess && (
              <span className="text-[11px] text-[var(--ok,#16a34a)]">
                {t("providerswitcher.savedRestartingAgent")}
              </span>
            )}
            <Button
              variant="default"
              size="sm"
              className="!mt-0"
              onClick={() => void handlePiAiSave()}
              disabled={piAiSaving}
            >
              {piAiSaving
                ? t("providerswitcher.saveInProgress")
                : t("providerswitcher.save")}
            </Button>
          </div>
        </div>
      )}

      {/* Local provider settings (API keys) */}
      {!isCloudSelected && (
        <ApiKeyConfig
          selectedProvider={selectedProvider}
          pluginSaving={pluginSaving}
          pluginSaveSuccess={pluginSaveSuccess}
          handlePluginConfigSave={handlePluginConfigSave}
          loadPlugins={loadPlugins}
        />
      )}
    </>
  );
}
