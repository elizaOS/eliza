import { resolveServiceRoutingInConfig } from "@elizaos/shared/contracts/onboarding";
import {
  buildElizaCloudServiceRoute,
  normalizeServiceRoutingConfig,
} from "@elizaos/shared/contracts/service-routing";
import { asRecord } from "@elizaos/shared/type-guards";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useTimeout,
} from "@elizaos/ui";
import { CheckCircle2, Cloud, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, type OnboardingOptions, type PluginParamDef } from "../../api";
import { ConfigRenderer, defaultRegistry } from "../../config";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import {
  getOnboardingProviderOption,
  isSubscriptionProviderSelectionId,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  type SubscriptionProviderSelectionId,
} from "../../providers";
import { useApp } from "../../state";
import type { ConfigUiHint } from "../../types";
import { CloudDashboard } from "../pages/ElizaCloudDashboard";
import { ApiKeyConfig } from "./ApiKeyConfig";
import {
  buildCloudModelSchema,
  DEFAULT_ACTION_PLANNER_MODEL,
  DEFAULT_RESPONSE_HANDLER_MODEL,
} from "./cloud-model-schema";
import { SubscriptionStatus } from "./SubscriptionStatus";
import { AdvancedSettingsDisclosure } from "./settings-control-primitives";

const SUBSCRIPTION_PROVIDER_LABEL_FALLBACKS: Record<
  SubscriptionProviderSelectionId,
  string
> = {
  "anthropic-subscription": "Claude Subscription",
  "openai-subscription": "ChatGPT Subscription",
};

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
  elizaCloudConnected?: boolean;
  plugins?: PluginInfo[];
  pluginSaving?: Set<string>;
  pluginSaveSuccess?: Set<string>;
  loadPlugins?: () => Promise<void>;
  handlePluginConfigSave?: (
    pluginId: string,
    values: Record<string, unknown>,
  ) => void | Promise<void>;
}

function getSubscriptionProviderLabel(
  provider: { id: SubscriptionProviderSelectionId; labelKey: string },
  t: (key: string) => string,
): string {
  const translated = t(provider.labelKey);
  if (translated !== provider.labelKey) return translated;
  return SUBSCRIPTION_PROVIDER_LABEL_FALLBACKS[provider.id] ?? provider.id;
}

function readSubscriptionProvider(
  cfg: Record<string, unknown>,
): SubscriptionProviderSelectionId | null {
  const agents = asRecord(cfg.agents);
  const defaults = asRecord(agents?.defaults);
  const subscriptionProvider = defaults?.subscriptionProvider;
  return typeof subscriptionProvider === "string" &&
    isSubscriptionProviderSelectionId(subscriptionProvider)
    ? subscriptionProvider
    : null;
}

function readConfigString(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string {
  const value = source?.[key];
  return typeof value === "string" ? value : "";
}

export function ProviderSwitcher(props: ProviderSwitcherProps = {}) {
  const { setTimeout } = useTimeout();
  const app = useApp();
  const branding = useBranding();
  const t = app.t;
  const elizaCloudConnected =
    props.elizaCloudConnected ?? Boolean(app.elizaCloudConnected);
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
  const handlePluginConfigSave =
    props.handlePluginConfigSave ?? app.handlePluginConfigSave;
  const setActionNotice = app.setActionNotice;

  const [modelOptions, setModelOptions] = useState<
    OnboardingOptions["models"] | null
  >(null);
  const [currentNanoModel, setCurrentNanoModel] = useState("");
  const [currentSmallModel, setCurrentSmallModel] = useState("");
  const [currentMediumModel, setCurrentMediumModel] = useState("");
  const [currentLargeModel, setCurrentLargeModel] = useState("");
  const [currentMegaModel, setCurrentMegaModel] = useState("");
  const [currentResponseHandlerModel, setCurrentResponseHandlerModel] =
    useState(DEFAULT_RESPONSE_HANDLER_MODEL);
  const [currentActionPlannerModel, setCurrentActionPlannerModel] = useState(
    DEFAULT_ACTION_PLANNER_MODEL,
  );
  const [modelSaving, setModelSaving] = useState(false);
  const [modelSaveSuccess, setModelSaveSuccess] = useState(false);
  const [cloudCallsDisabled, setCloudCallsDisabled] = useState(false);
  const [routingModeSaving, setRoutingModeSaving] = useState(false);

  const [subscriptionStatus, setSubscriptionStatus] = useState<
    Array<{
      provider: string;
      configured: boolean;
      valid: boolean;
      expiresAt: number | null;
      source?: "app" | "claude-code-cli" | "setup-token" | "codex-cli" | null;
    }>
  >([]);
  const [anthropicConnected, setAnthropicConnected] = useState(false);
  const [anthropicCliDetected, setAnthropicCliDetected] = useState(false);
  const [openaiConnected, setOpenaiConnected] = useState(false);

  const hasManualSelection = useRef(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );

  const readCloudCallsDisabled = useCallback(
    (cfg: Record<string, unknown>): boolean => {
      const cloud = asRecord(cfg.cloud);
      const services = asRecord(cloud?.services);
      return Boolean(
        cloud?.enabled === false ||
          cloud?.inferenceMode === "local" ||
          services?.inference === false,
      );
    },
    [],
  );

  const syncSelectionFromConfig = useCallback(
    (cfg: Record<string, unknown>) => {
      const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
      const providerId = getOnboardingProviderOption(llmText?.backend)?.id;
      const savedSubscriptionProvider = readSubscriptionProvider(cfg);
      const nextSelectedId =
        llmText?.transport === "cloud-proxy" && providerId === "elizacloud"
          ? "__cloud__"
          : llmText?.transport === "direct"
            ? (providerId ?? null)
            : llmText?.transport === "remote" && providerId
              ? providerId
              : savedSubscriptionProvider;

      if (!hasManualSelection.current) {
        setSelectedProviderId(nextSelectedId);
      }
      setCloudCallsDisabled(readCloudCallsDisabled(cfg));
    },
    [readCloudCallsDisabled],
  );

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
        setModelOptions({
          nano: opts.models?.nano ?? [],
          small: opts.models?.small ?? [],
          medium: opts.models?.medium ?? [],
          large: opts.models?.large ?? [],
          mega: opts.models?.mega ?? [],
        });
      } catch (err) {
        console.warn("[eliza] Failed to load onboarding options", err);
      }
      try {
        const cfg = await client.getConfig();
        const models = asRecord(cfg.models);
        const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
        const providerId = getOnboardingProviderOption(llmText?.backend)?.id;
        const elizaCloudEnabledCfg =
          llmText?.transport === "cloud-proxy" && providerId === "elizacloud";
        const defaults = {
          nano: "openai/gpt-5.4-nano",
          small: "minimax/minimax-m2.7",
          medium: "anthropic/claude-sonnet-4.6",
          large: "moonshotai/kimi-k2.5",
          mega: "anthropic/claude-sonnet-4.6",
        };

        const vars = asRecord(asRecord(cfg.env)?.vars);
        const envFor = (key: string) => readConfigString(vars, key);

        setCurrentNanoModel(
          readConfigString(models, "nano") ||
            llmText?.nanoModel ||
            envFor("NANO_MODEL") ||
            (elizaCloudEnabledCfg ? defaults.nano : ""),
        );
        setCurrentSmallModel(
          readConfigString(models, "small") ||
            llmText?.smallModel ||
            envFor("SMALL_MODEL") ||
            (elizaCloudEnabledCfg ? defaults.small : ""),
        );
        setCurrentMediumModel(
          readConfigString(models, "medium") ||
            llmText?.mediumModel ||
            envFor("MEDIUM_MODEL") ||
            (elizaCloudEnabledCfg ? defaults.medium : ""),
        );
        setCurrentLargeModel(
          readConfigString(models, "large") ||
            llmText?.largeModel ||
            envFor("LARGE_MODEL") ||
            (elizaCloudEnabledCfg ? defaults.large : ""),
        );
        setCurrentMegaModel(
          readConfigString(models, "mega") ||
            llmText?.megaModel ||
            envFor("MEGA_MODEL") ||
            (elizaCloudEnabledCfg ? defaults.mega : ""),
        );
        setCurrentResponseHandlerModel(
          llmText?.responseHandlerModel || DEFAULT_RESPONSE_HANDLER_MODEL,
        );
        setCurrentActionPlannerModel(
          llmText?.actionPlannerModel || DEFAULT_ACTION_PLANNER_MODEL,
        );
        syncSelectionFromConfig(cfg);
      } catch (err) {
        console.warn("[eliza] Failed to load config", err);
      }
    })();
  }, [loadSubscriptionStatus, syncSelectionFromConfig]);

  useEffect(() => {
    const anthStatus = subscriptionStatus.find(
      (s) => s.provider === "anthropic-subscription",
    );
    const oaiStatus = subscriptionStatus.find(
      (s) =>
        s.provider === "openai-subscription" || s.provider === "openai-codex",
    );
    // Only treat as "connected" when credentials were linked via the in-app
    // OAuth flow (source === "app"). Claude Code CLI credentials detected on
    // the machine are surfaced separately — the app can't disconnect them.
    const anthAppConnected = Boolean(
      anthStatus?.configured &&
        anthStatus?.valid &&
        anthStatus?.source === "app",
    );
    setAnthropicConnected(anthAppConnected);
    setAnthropicCliDetected(
      Boolean(
        anthStatus?.configured &&
          anthStatus?.valid &&
          anthStatus?.source === "claude-code-cli",
      ),
    );
    setOpenaiConnected(Boolean(oaiStatus?.configured && oaiStatus?.valid));
  }, [subscriptionStatus]);

  const allAiProviders = useMemo(
    () =>
      [...plugins.filter((p) => p.category === "ai-provider")].sort(
        (left, right) => {
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
        },
      ),
    [plugins],
  );
  const availableProviderIds = useMemo(
    () =>
      new Set(
        allAiProviders
          .map(
            (provider) =>
              getOnboardingProviderOption(
                normalizeAiProviderPluginId(provider.id),
              )?.id,
          )
          .filter((id): id is NonNullable<typeof id> => id != null),
      ),
    [allAiProviders],
  );

  const resolvedSelectedId = useMemo(
    () =>
      selectedProviderId === "__cloud__"
        ? "__cloud__"
        : selectedProviderId &&
            (availableProviderIds.has(selectedProviderId) ||
              isSubscriptionProviderSelectionId(selectedProviderId))
          ? selectedProviderId
          : null,
    [availableProviderIds, selectedProviderId],
  );

  const selectedProvider = useMemo(() => {
    if (
      !resolvedSelectedId ||
      resolvedSelectedId === "__cloud__" ||
      isSubscriptionProviderSelectionId(resolvedSelectedId)
    ) {
      return null;
    }
    return (
      allAiProviders.find(
        (provider) =>
          (getOnboardingProviderOption(normalizeAiProviderPluginId(provider.id))
            ?.id ?? normalizeAiProviderPluginId(provider.id)) ===
          resolvedSelectedId,
      ) ?? null
    );
  }, [allAiProviders, resolvedSelectedId]);

  const restoreSelection = useCallback(
    (previousSelectedId: string | null, previousManualSelection: boolean) => {
      hasManualSelection.current = previousManualSelection;
      setSelectedProviderId(previousSelectedId);
    },
    [],
  );

  const notifySelectionFailure = useCallback(
    (prefix: string, err: unknown) => {
      const message =
        err instanceof Error && err.message.trim()
          ? `${prefix}: ${err.message}`
          : prefix;
      setActionNotice?.(message, "error", 6000);
    },
    [setActionNotice],
  );

  const handleSwitchProvider = useCallback(
    async (newId: string) => {
      const previousSelectedId = resolvedSelectedId;
      const previousManualSelection = hasManualSelection.current;
      hasManualSelection.current = true;
      setSelectedProviderId(newId);
      const target =
        allAiProviders.find(
          (provider) =>
            (getOnboardingProviderOption(
              normalizeAiProviderPluginId(provider.id),
            )?.id ?? normalizeAiProviderPluginId(provider.id)) === newId,
        ) ?? null;
      const providerId =
        getOnboardingProviderOption(
          normalizeAiProviderPluginId(target?.id ?? newId),
        )?.id ?? newId;

      try {
        await client.switchProvider(providerId);
      } catch (err) {
        restoreSelection(previousSelectedId, previousManualSelection);
        notifySelectionFailure("Failed to switch AI provider", err);
      }
    },
    [
      allAiProviders,
      notifySelectionFailure,
      resolvedSelectedId,
      restoreSelection,
    ],
  );

  const handleSelectSubscription = useCallback(
    async (
      providerId: SubscriptionProviderSelectionId,
      activate: boolean = true,
    ) => {
      if (!cloudCallsDisabled && resolvedSelectedId === providerId) return;
      const previousSelectedId = resolvedSelectedId;
      const previousManualSelection = hasManualSelection.current;
      hasManualSelection.current = true;
      setSelectedProviderId(providerId);
      if (!activate) return;
      try {
        await client.switchProvider(providerId);
      } catch (err) {
        restoreSelection(previousSelectedId, previousManualSelection);
        notifySelectionFailure("Failed to update subscription provider", err);
      }
    },
    [
      cloudCallsDisabled,
      notifySelectionFailure,
      resolvedSelectedId,
      restoreSelection,
    ],
  );

  const handleSelectCloud = useCallback(async () => {
    if (!cloudCallsDisabled && resolvedSelectedId === "__cloud__") return;
    const previousSelectedId = resolvedSelectedId;
    const previousManualSelection = hasManualSelection.current;
    const previousCloudCallsDisabled = cloudCallsDisabled;
    hasManualSelection.current = true;
    setSelectedProviderId("__cloud__");
    setCloudCallsDisabled(false);
    setRoutingModeSaving(true);
    try {
      await client.switchProvider("elizacloud");
    } catch (err) {
      restoreSelection(previousSelectedId, previousManualSelection);
      setCloudCallsDisabled(previousCloudCallsDisabled);
      notifySelectionFailure("Failed to select Eliza Cloud", err);
    } finally {
      setRoutingModeSaving(false);
    }
  }, [
    cloudCallsDisabled,
    notifySelectionFailure,
    resolvedSelectedId,
    restoreSelection,
  ]);

  const handleSelectLocalOnly = useCallback(async () => {
    const previousSelectedId = resolvedSelectedId;
    const previousManualSelection = hasManualSelection.current;
    const previousCloudCallsDisabled = cloudCallsDisabled;
    hasManualSelection.current = true;
    setCloudCallsDisabled(true);
    setRoutingModeSaving(true);
    try {
      const cfg = await client.getConfig();
      const cloud = asRecord(cfg.cloud) ?? {};
      await client.updateConfig({
        deploymentTarget: { runtime: "local" },
        cloud: {
          ...cloud,
          enabled: false,
          inferenceMode: "local",
          services: {
            inference: false,
            media: false,
            tts: false,
            embeddings: false,
            rpc: false,
          },
        },
        serviceRouting: null,
      });
      void client.restartAgent().catch((err) => {
        notifySelectionFailure("Local-only mode saved; restart failed", err);
      });
    } catch (err) {
      restoreSelection(previousSelectedId, previousManualSelection);
      setCloudCallsDisabled(previousCloudCallsDisabled);
      notifySelectionFailure("Failed to enable local-only mode", err);
    } finally {
      setRoutingModeSaving(false);
    }
  }, [
    cloudCallsDisabled,
    notifySelectionFailure,
    resolvedSelectedId,
    restoreSelection,
  ]);

  const isCloudSelected =
    resolvedSelectedId === "__cloud__" || resolvedSelectedId === null;
  const isSubscriptionSelected =
    isSubscriptionProviderSelectionId(resolvedSelectedId);
  const providerChoices = [
    {
      id: "__cloud__",
      label: t("common.cloud"),
      disabled: false,
    },
    ...SUBSCRIPTION_PROVIDER_SELECTIONS.map((provider) => ({
      id: provider.id,
      label: getSubscriptionProviderLabel(provider, t),
      disabled: false,
    })),
    // Only surface providers the backend's /api/provider/switch endpoint
    // actually accepts (i.e. entries in ONBOARDING_PROVIDER_CATALOG). Plugins
    // without a catalog entry — e.g. `local-ai`, which is configured via the
    // dedicated "Local Models" settings section, not this dropdown — are
    // filtered out, otherwise selecting them returns "Invalid provider".
    ...allAiProviders
      .map((provider) => {
        const option = getOnboardingProviderOption(
          normalizeAiProviderPluginId(provider.id),
        );
        return option
          ? {
              id: option.id,
              label: option.name,
              disabled: false,
            }
          : null;
      })
      .filter(
        (choice): choice is NonNullable<typeof choice> => choice !== null,
      ),
  ];

  const cloudModelSchema = useMemo(
    () => (modelOptions ? buildCloudModelSchema(modelOptions) : null),
    [modelOptions],
  );
  const largeModelOptions = modelOptions?.large ?? [];

  const modelValues = useMemo(() => {
    const values: Record<string, unknown> = {};
    const setKeys = new Set<string>();
    const put = (key: string, value: string) => {
      if (value) {
        values[key] = value;
        setKeys.add(key);
      }
    };
    put("nano", currentNanoModel);
    put("small", currentSmallModel);
    put("medium", currentMediumModel);
    put("large", currentLargeModel);
    put("mega", currentMegaModel);
    put("responseHandler", currentResponseHandlerModel);
    put("actionPlanner", currentActionPlannerModel);
    return { values, setKeys };
  }, [
    currentActionPlannerModel,
    currentLargeModel,
    currentMediumModel,
    currentMegaModel,
    currentNanoModel,
    currentResponseHandlerModel,
    currentSmallModel,
  ]);

  const handleModelFieldChange = useCallback(
    (key: string, value: unknown) => {
      const val = String(value);
      const next = {
        nano: key === "nano" ? val : currentNanoModel,
        small: key === "small" ? val : currentSmallModel,
        medium: key === "medium" ? val : currentMediumModel,
        large: key === "large" ? val : currentLargeModel,
        mega: key === "mega" ? val : currentMegaModel,
        responseHandler:
          key === "responseHandler" ? val : currentResponseHandlerModel,
        actionPlanner:
          key === "actionPlanner" ? val : currentActionPlannerModel,
      };

      if (key === "nano") setCurrentNanoModel(val);
      if (key === "small") setCurrentSmallModel(val);
      if (key === "medium") setCurrentMediumModel(val);
      if (key === "large") setCurrentLargeModel(val);
      if (key === "mega") setCurrentMegaModel(val);
      if (key === "responseHandler") setCurrentResponseHandlerModel(val);
      if (key === "actionPlanner") setCurrentActionPlannerModel(val);

      void (async () => {
        setModelSaving(true);
        try {
          const cfg = await client.getConfig();
          const existingRouting = resolveServiceRoutingInConfig(cfg)?.llmText;
          const llmText = buildElizaCloudServiceRoute({
            nanoModel: next.nano,
            smallModel: next.small,
            mediumModel: next.medium,
            largeModel: next.large,
            megaModel: next.mega,
            ...(next.responseHandler !== DEFAULT_RESPONSE_HANDLER_MODEL
              ? { responseHandlerModel: next.responseHandler }
              : {}),
            ...(next.actionPlanner !== DEFAULT_ACTION_PLANNER_MODEL
              ? { actionPlannerModel: next.actionPlanner }
              : {}),
            ...(existingRouting?.shouldRespondModel
              ? { shouldRespondModel: existingRouting.shouldRespondModel }
              : {}),
            ...(existingRouting?.plannerModel
              ? { plannerModel: existingRouting.plannerModel }
              : {}),
            ...(existingRouting?.responseModel
              ? { responseModel: existingRouting.responseModel }
              : {}),
            ...(existingRouting?.mediaDescriptionModel
              ? {
                  mediaDescriptionModel: existingRouting.mediaDescriptionModel,
                }
              : {}),
          });
          await client.updateConfig({
            models: {
              nano: next.nano,
              small: next.small,
              medium: next.medium,
              large: next.large,
              mega: next.mega,
            },
            serviceRouting: {
              ...(normalizeServiceRoutingConfig(cfg.serviceRouting) ?? {}),
              llmText,
            },
          });
          setModelSaveSuccess(true);
          setTimeout(() => setModelSaveSuccess(false), 2000);
          await client.restartAgent();
        } catch (err) {
          notifySelectionFailure("Failed to save cloud model config", err);
        }
        setModelSaving(false);
      })();
    },
    [
      currentActionPlannerModel,
      currentLargeModel,
      currentMediumModel,
      currentMegaModel,
      currentNanoModel,
      currentResponseHandlerModel,
      currentSmallModel,
      notifySelectionFailure,
      setTimeout,
    ],
  );

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted">
          Cloud access
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            type="button"
            variant={
              !cloudCallsDisabled && isCloudSelected ? "default" : "outline"
            }
            className="h-auto justify-start rounded-xl px-3 py-2 text-left"
            disabled={routingModeSaving}
            onClick={() => void handleSelectCloud()}
          >
            <Cloud className="h-4 w-4 text-current" aria-hidden />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">Cloud allowed</span>
              <span className="text-xs font-normal opacity-75">
                Use connected providers and cloud fallback.
              </span>
            </span>
          </Button>
          <Button
            type="button"
            variant={cloudCallsDisabled ? "default" : "outline"}
            className="h-auto justify-start rounded-xl px-3 py-2 text-left"
            disabled={routingModeSaving}
            onClick={() => void handleSelectLocalOnly()}
          >
            <ShieldCheck className="h-4 w-4 text-current" aria-hidden />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-semibold">Local only</span>
              <span className="text-xs font-normal opacity-75">
                No cloud calls anywhere.
              </span>
            </span>
          </Button>
        </div>
      </div>

      {!cloudCallsDisabled && (
        <div>
          <label
            htmlFor="provider-switcher-select"
            className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted"
          >
            {t("common.provider", {
              defaultValue: "Provider",
            })}
          </label>
          <Select
            value={resolvedSelectedId ?? "__cloud__"}
            onValueChange={(nextId: string) => {
              if (nextId === "__cloud__") {
                void handleSelectCloud();
                return;
              }
              if (isSubscriptionProviderSelectionId(nextId)) {
                if (
                  nextId === "anthropic-subscription" ||
                  (nextId === "openai-subscription" && !openaiConnected)
                ) {
                  void handleSelectSubscription(nextId, false);
                  return;
                }
                void handleSelectSubscription(nextId);
                return;
              }
              void handleSwitchProvider(nextId);
            }}
          >
            <SelectTrigger
              id="provider-switcher-select"
              aria-label={t("common.provider", {
                defaultValue: "Provider",
              })}
              className="h-9 w-full max-w-sm rounded-lg border border-border bg-card text-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-64">
              {providerChoices.map((choice) => (
                <SelectItem
                  key={choice.id}
                  value={choice.id}
                  disabled={choice.disabled}
                >
                  {choice.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {!cloudCallsDisabled && isCloudSelected && (
        <div className="overflow-hidden rounded-xl border border-border/40 bg-card/40">
          <CloudDashboard />
          {elizaCloudConnected &&
          (largeModelOptions.length > 0 || cloudModelSchema) ? (
            <div className="border-t border-border/40 px-4 py-4 sm:px-5">
              {largeModelOptions.length > 0 ? (
                <div>
                  <label
                    htmlFor="provider-switcher-primary-model"
                    className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted"
                  >
                    {t("providerswitcher.model", { defaultValue: "Model" })}
                  </label>
                  <Select
                    value={currentLargeModel || ""}
                    onValueChange={(v) => handleModelFieldChange("large", v)}
                  >
                    <SelectTrigger
                      id="provider-switcher-primary-model"
                      className="h-9 w-full max-w-sm rounded-lg border border-border bg-card text-sm"
                    >
                      <SelectValue
                        placeholder={t("providerswitcher.chooseModel", {
                          defaultValue: "Choose a model",
                        })}
                      />
                    </SelectTrigger>
                    <SelectContent className="max-h-64">
                      {largeModelOptions.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {cloudModelSchema ? (
                <AdvancedSettingsDisclosure
                  title="Model overrides"
                  className="mt-4"
                >
                  <ConfigRenderer
                    schema={cloudModelSchema.schema}
                    hints={cloudModelSchema.hints}
                    values={modelValues.values}
                    setKeys={modelValues.setKeys}
                    registry={defaultRegistry}
                    onChange={handleModelFieldChange}
                  />
                </AdvancedSettingsDisclosure>
              ) : null}
              <div className="mt-2 flex items-center justify-between gap-2">
                <p className="text-xs-tight text-muted">
                  {t(
                    "providerswitcher.restartRequiredHint",
                    appNameInterpolationVars(branding),
                  )}
                </p>
                <div className="flex items-center gap-2">
                  {modelSaving && (
                    <span
                      className="inline-flex items-center text-muted"
                      title={t("providerswitcher.savingRestarting")}
                      role="status"
                      aria-label={t("providerswitcher.savingRestarting")}
                    >
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    </span>
                  )}
                  {modelSaveSuccess && (
                    <span
                      className="inline-flex items-center text-ok"
                      title={t("providerswitcher.savedRestartingAgent")}
                      role="status"
                      aria-label={t("providerswitcher.savedRestartingAgent")}
                    >
                      <CheckCircle2 className="h-3.5 w-3.5" />
                    </span>
                  )}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      )}

      {!cloudCallsDisabled && isSubscriptionSelected && (
        <SubscriptionStatus
          resolvedSelectedId={resolvedSelectedId}
          subscriptionStatus={subscriptionStatus}
          anthropicConnected={anthropicConnected}
          setAnthropicConnected={setAnthropicConnected}
          anthropicCliDetected={anthropicCliDetected}
          openaiConnected={openaiConnected}
          setOpenaiConnected={setOpenaiConnected}
          handleSelectSubscription={handleSelectSubscription}
          loadSubscriptionStatus={loadSubscriptionStatus}
        />
      )}

      {!cloudCallsDisabled && !isCloudSelected && !isSubscriptionSelected && (
        <ApiKeyConfig
          selectedProvider={selectedProvider}
          pluginSaving={pluginSaving}
          pluginSaveSuccess={pluginSaveSuccess}
          handlePluginConfigSave={handlePluginConfigSave}
          loadPlugins={loadPlugins}
        />
      )}
    </div>
  );
}
