/**
 * ProviderSwitcher — Provider grid, cloud settings, and switching logic.
 *
 * Extracted from SettingsView.tsx for decomposition (P2 §10).
 * Composes SubscriptionStatus and ApiKeyConfig sub-components.
 */

import { resolveServiceRoutingInConfig } from "@elizaos/shared/contracts/onboarding";
import { buildElizaCloudServiceRoute } from "@elizaos/shared/contracts/service-routing";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, type OnboardingOptions, type PluginParamDef } from "../../api";
import {
  ConfigRenderer,
  defaultRegistry,
  type JsonSchemaObject,
} from "../../config";
import { useBranding } from "../../config/branding";
import { useTimeout } from "@elizaos/ui";
import {
  getOnboardingProviderOption,
  isSubscriptionProviderSelectionId,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  type SubscriptionProviderSelectionId,
} from "../../providers";
import { useApp } from "../../state";
import type { ConfigUiHint } from "../../types";
import { openExternalUrl } from "../../utils";
import { ApiKeyConfig } from "./ApiKeyConfig";
import { SubscriptionStatus } from "./SubscriptionStatus";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@elizaos/ui";

const SUBSCRIPTION_PROVIDER_LABEL_FALLBACKS: Record<
  SubscriptionProviderSelectionId,
  string
> = {
  "anthropic-subscription": "Claude Subscription",
  "openai-subscription": "ChatGPT Subscription",
};

const DEFAULT_RESPONSE_HANDLER_MODEL = "__DEFAULT_RESPONSE_HANDLER__";
const DEFAULT_ACTION_PLANNER_MODEL = "__DEFAULT_ACTION_PLANNER__";

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

function getSubscriptionProviderLabel(
  provider: {
    id: SubscriptionProviderSelectionId;
    labelKey: string;
  },
  t: (key: string) => string,
): string {
  const translated = t(provider.labelKey);
  if (translated !== provider.labelKey) {
    return translated;
  }

  return SUBSCRIPTION_PROVIDER_LABEL_FALLBACKS[provider.id] ?? provider.id;
}

export function ProviderSwitcher(props: ProviderSwitcherProps = {}) {
  const { setTimeout } = useTimeout();
  const app = useApp();
  const branding = useBranding();
  const t = app.t;
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
  const handlePluginConfigSave =
    props.handlePluginConfigSave ?? app.handlePluginConfigSave;
  const handleCloudLogin = props.handleCloudLogin ?? app.handleCloudLogin;
  const handleCloudDisconnect =
    props.handleCloudDisconnect ?? app.handleCloudDisconnect;
  const setState = props.setState ?? app.setState;
  const setTab = props.setTab ?? app.setTab;
  const setActionNotice = app.setActionNotice;
  /* ── Model selection state ─────────────────────────────────────── */
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

  const syncSelectionFromConfig = useCallback(
    (cfg: Record<string, unknown>) => {
      const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
      const providerId = getOnboardingProviderOption(llmText?.backend)?.id;
      const savedSubscriptionProvider =
        typeof (cfg.agents as { defaults?: { subscriptionProvider?: unknown } })
          ?.defaults?.subscriptionProvider === "string" &&
        isSubscriptionProviderSelectionId(
          (cfg.agents as { defaults?: { subscriptionProvider?: string } })
            .defaults?.subscriptionProvider ?? "",
        )
          ? ((cfg.agents as { defaults?: { subscriptionProvider?: string } })
              .defaults?.subscriptionProvider ?? null)
          : null;
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
    },
    [],
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
        const models = cfg.models as Record<string, string> | undefined;
        const llmText = resolveServiceRoutingInConfig(
          cfg as Record<string, unknown>,
        )?.llmText;
        const providerId = getOnboardingProviderOption(llmText?.backend)?.id;
        const elizaCloudEnabledCfg =
          llmText?.transport === "cloud-proxy" && providerId === "elizacloud";
        const defaultNano = "openai/gpt-5.4-nano";
        const defaultSmall = "minimax/minimax-m2.7";
        const defaultMedium = "anthropic/claude-sonnet-4.6";
        const defaultLarge = "moonshotai/kimi-k2.5";
        const defaultMega = "anthropic/claude-sonnet-4.6";

        // Environment variables — needed for model fallback
        const env = cfg.env as Record<string, unknown> | undefined;
        const vars = (env?.vars as Record<string, unknown> | undefined) ?? {};

        // Fall back to SMALL_MODEL / LARGE_MODEL env vars when cfg.models
        // is empty.  Local providers (e.g. Ollama) store the active model
        // names as env vars rather than in cfg.models.
        const envNano =
          typeof vars.NANO_MODEL === "string" ? vars.NANO_MODEL : "";
        const envSmall =
          typeof vars.SMALL_MODEL === "string" ? vars.SMALL_MODEL : "";
        const envMedium =
          typeof vars.MEDIUM_MODEL === "string" ? vars.MEDIUM_MODEL : "";
        const envLarge =
          typeof vars.LARGE_MODEL === "string" ? vars.LARGE_MODEL : "";
        const envMega =
          typeof vars.MEGA_MODEL === "string" ? vars.MEGA_MODEL : "";
        setCurrentNanoModel(
          models?.nano ||
            llmText?.nanoModel ||
            envNano ||
            (elizaCloudEnabledCfg ? defaultNano : ""),
        );
        setCurrentSmallModel(
          models?.small ||
            llmText?.smallModel ||
            envSmall ||
            (elizaCloudEnabledCfg ? defaultSmall : ""),
        );
        setCurrentMediumModel(
          models?.medium ||
            llmText?.mediumModel ||
            envMedium ||
            (elizaCloudEnabledCfg ? defaultMedium : ""),
        );
        setCurrentLargeModel(
          models?.large ||
            llmText?.largeModel ||
            envLarge ||
            (elizaCloudEnabledCfg ? defaultLarge : ""),
        );
        setCurrentMegaModel(
          models?.mega ||
            llmText?.megaModel ||
            envMega ||
            (elizaCloudEnabledCfg ? defaultMega : ""),
        );
        setCurrentResponseHandlerModel(
          llmText?.responseHandlerModel || DEFAULT_RESPONSE_HANDLER_MODEL,
        );
        setCurrentActionPlannerModel(
          llmText?.actionPlannerModel || DEFAULT_ACTION_PLANNER_MODEL,
        );
        syncSelectionFromConfig(cfg as Record<string, unknown>);
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
    setAnthropicConnected(Boolean(anthStatus?.configured && anthStatus?.valid));
    setOpenaiConnected(Boolean(oaiStatus?.configured && oaiStatus?.valid));
  }, [subscriptionStatus]);

  /* ── Derived ──────────────────────────────────────────────────── */
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
        allAiProviders.map(
          (provider) =>
            getOnboardingProviderOption(
              normalizeAiProviderPluginId(provider.id),
            )?.id ?? normalizeAiProviderPluginId(provider.id),
        ),
      ),
    [allAiProviders],
  );

  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );
  const hasManualSelection = useRef(false);

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

  /* ── Handlers ─────────────────────────────────────────────────── */
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
      const previousSelectedId = resolvedSelectedId;
      const previousManualSelection = hasManualSelection.current;
      hasManualSelection.current = true;
      setSelectedProviderId(providerId);

      if (!activate) {
        return;
      }

      try {
        await client.switchProvider(providerId);
      } catch (err) {
        restoreSelection(previousSelectedId, previousManualSelection);
        notifySelectionFailure("Failed to update subscription provider", err);
      }
    },
    [notifySelectionFailure, resolvedSelectedId, restoreSelection],
  );

  const handleSelectCloud = useCallback(async () => {
    const previousSelectedId = resolvedSelectedId;
    const previousManualSelection = hasManualSelection.current;
    hasManualSelection.current = true;
    setSelectedProviderId("__cloud__");
    try {
      await client.switchProvider("elizacloud");
    } catch (err) {
      restoreSelection(previousSelectedId, previousManualSelection);
      notifySelectionFailure("Failed to select Eliza Cloud", err);
    }
  }, [notifySelectionFailure, resolvedSelectedId, restoreSelection]);

  /* ── Render ───────────────────────────────────────────────────── */
  const isCloudSelected = resolvedSelectedId === "__cloud__";
  const isSubscriptionSelected =
    isSubscriptionProviderSelectionId(resolvedSelectedId);
  const providerChoices = [
    {
      id: "__cloud__",
      label: t("providerswitcher.elizaCloud"),
      disabled: false,
    },
    ...SUBSCRIPTION_PROVIDER_SELECTIONS.map((provider) => ({
      id: provider.id,
      label: getSubscriptionProviderLabel(provider, t),
      disabled: false,
    })),
    ...allAiProviders.map((provider) => ({
      id:
        getOnboardingProviderOption(normalizeAiProviderPluginId(provider.id))
          ?.id ?? normalizeAiProviderPluginId(provider.id),
      label:
        getOnboardingProviderOption(normalizeAiProviderPluginId(provider.id))
          ?.name ?? provider.name,
      disabled: false,
    })),
  ];

  return (
    <>
      {/* Provider dropdown - works for all screen sizes */}
      <div className="mb-3">
        <label
          htmlFor="provider-switcher-select"
          className="block text-xs font-semibold mb-1.5 text-muted"
        >
          {t("providerswitcher.selectAIProvider")}
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
            className="w-full px-3 py-2.5 border border-border bg-card text-sm rounded-lg transition-all duration-200 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none hover:border-border-hover"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
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
        <p className="text-xs-tight text-muted mt-1.5">
          {t("providerswitcher.chooseYourPreferredProvider")}
        </p>
        <p className="text-xs-tight text-muted mt-1">
          {t("providerswitcher.cloudInferenceToggleHint")}
        </p>
      </div>

      {/* Cloud settings */}
      {isCloudSelected && (
        <div className="mt-4 pt-4">
          {elizaCloudConnected ? (
            <div>
              <div className="flex justify-between items-center mb-3">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-ok" />
                  <span className="text-xs font-semibold">
                    {t("providerswitcher.loggedIntoElizaCloud")}
                  </span>
                </div>
                <Button
                  type="button"
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
                  <span className="text-muted mr-3">
                    <code className="font-[var(--mono)] text-xs-tight">
                      {elizaCloudUserId}
                    </code>
                  </span>
                )}
                {elizaCloudCredits !== null && (
                  <span>
                    <span className="text-muted">
                      {t("configpageview.Credits")}
                    </span>{" "}
                    <span
                      className={
                        elizaCloudCreditsCritical
                          ? "text-danger font-bold"
                          : elizaCloudCreditsLow
                            ? "rounded-md bg-warn-subtle px-1.5 py-0.5 text-txt font-bold"
                            : ""
                      }
                    >
                      ${elizaCloudCredits.toFixed(2)}
                    </span>
                    <Button
                      variant="link"
                      size="sm"
                      type="button"
                      onClick={() => {
                        setState("cloudDashboardView", "billing");
                        setTab("settings");
                      }}
                      className="ml-2 bg-transparent border-0 p-0 cursor-pointer text-xs-tight text-txt underline decoration-accent underline-offset-2 hover:opacity-80 h-auto min-h-0"
                    >
                      {t("configpageview.TopUp")}
                    </Button>
                  </span>
                )}
              </div>

              {modelOptions &&
                (() => {
                  const nanoOptions = modelOptions.nano ?? [];
                  const smallOptions = modelOptions.small ?? [];
                  const mediumOptions = modelOptions.medium ?? [];
                  const largeOptions = modelOptions.large ?? [];
                  const megaOptions = modelOptions.mega ?? [];
                  const allModelChoices = Array.from(
                    new Map(
                      [
                        ...nanoOptions,
                        ...smallOptions,
                        ...mediumOptions,
                        ...largeOptions,
                        ...megaOptions,
                      ].map((model) => [model.id, model]),
                    ).values(),
                  );
                  const modelSchema = {
                    type: "object" as const,
                    properties: {
                      nano: {
                        type: "string",
                        enum: nanoOptions.map((m) => m.id),
                        description: "Fastest, cheapest text tier.",
                      },
                      small: {
                        type: "string",
                        enum: smallOptions.map((m) => m.id),
                        description: "Default lightweight text tier.",
                      },
                      medium: {
                        type: "string",
                        enum: mediumOptions.map((m) => m.id),
                        description: "Planning tier. Falls back to small.",
                      },
                      large: {
                        type: "string",
                        enum: largeOptions.map((m) => m.id),
                        description: "Primary high-capability text tier.",
                      },
                      mega: {
                        type: "string",
                        enum: megaOptions.map((m) => m.id),
                        description: "Future top tier. Falls back to large.",
                      },
                      responseHandler: {
                        type: "string",
                        enum: [
                          DEFAULT_RESPONSE_HANDLER_MODEL,
                          ...allModelChoices.map((m) => m.id),
                        ],
                        description:
                          "Should-respond / response-handler override. Defaults to nano.",
                      },
                      actionPlanner: {
                        type: "string",
                        enum: [
                          DEFAULT_ACTION_PLANNER_MODEL,
                          ...allModelChoices.map((m) => m.id),
                        ],
                        description: "Planning override. Defaults to medium.",
                      },
                    },
                    required: [] as string[],
                  };
                  const modelHints: Record<string, ConfigUiHint> = {
                    nano: {
                      label: "Nano Model",
                      width: "half",
                      options: nanoOptions.map((m) => ({
                        value: m.id,
                        label: m.name,
                        description: `${m.provider} — ${m.description}`,
                      })),
                    },
                    small: {
                      label: "Small Model",
                      width: "half",
                      options: smallOptions.map((m) => ({
                        value: m.id,
                        label: m.name,
                        description: `${m.provider} — ${m.description}`,
                      })),
                    },
                    medium: {
                      label: "Medium Model",
                      width: "half",
                      options: mediumOptions.map((m) => ({
                        value: m.id,
                        label: m.name,
                        description: `${m.provider} — ${m.description}`,
                      })),
                    },
                    large: {
                      label: "Large Model",
                      width: "half",
                      options: largeOptions.map((m) => ({
                        value: m.id,
                        label: m.name,
                        description: `${m.provider} — ${m.description}`,
                      })),
                    },
                    mega: {
                      label: "Mega Model",
                      width: "half",
                      options: megaOptions.map((m) => ({
                        value: m.id,
                        label: m.name,
                        description: `${m.provider} — ${m.description}`,
                      })),
                    },
                    responseHandler: {
                      label: "Response Handler",
                      width: "half",
                      options: [
                        {
                          value: DEFAULT_RESPONSE_HANDLER_MODEL,
                          label: "Default (Nano)",
                          description:
                            "Use the nano tier unless explicitly overridden.",
                        },
                        ...allModelChoices.map((m) => ({
                          value: m.id,
                          label: m.name,
                          description: `${m.provider} — ${m.description}`,
                        })),
                      ],
                    },
                    actionPlanner: {
                      label: "Action Planner",
                      width: "half",
                      options: [
                        {
                          value: DEFAULT_ACTION_PLANNER_MODEL,
                          label: "Default (Medium)",
                          description:
                            "Use the medium tier unless explicitly overridden.",
                        },
                        ...allModelChoices.map((m) => ({
                          value: m.id,
                          label: m.name,
                          description: `${m.provider} — ${m.description}`,
                        })),
                      ],
                    },
                  };
                  const modelValues: Record<string, unknown> = {};
                  const modelSetKeys = new Set<string>();
                  if (currentNanoModel) {
                    modelValues.nano = currentNanoModel;
                    modelSetKeys.add("nano");
                  }
                  if (currentSmallModel) {
                    modelValues.small = currentSmallModel;
                    modelSetKeys.add("small");
                  }
                  if (currentMediumModel) {
                    modelValues.medium = currentMediumModel;
                    modelSetKeys.add("medium");
                  }
                  if (currentLargeModel) {
                    modelValues.large = currentLargeModel;
                    modelSetKeys.add("large");
                  }
                  if (currentMegaModel) {
                    modelValues.mega = currentMegaModel;
                    modelSetKeys.add("mega");
                  }
                  if (currentResponseHandlerModel) {
                    modelValues.responseHandler = currentResponseHandlerModel;
                    modelSetKeys.add("responseHandler");
                  }
                  if (currentActionPlannerModel) {
                    modelValues.actionPlanner = currentActionPlannerModel;
                    modelSetKeys.add("actionPlanner");
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
                        const nextNano =
                          key === "nano" ? val : currentNanoModel;
                        const nextSmall =
                          key === "small" ? val : currentSmallModel;
                        const nextMedium =
                          key === "medium" ? val : currentMediumModel;
                        const nextLarge =
                          key === "large" ? val : currentLargeModel;
                        const nextMega =
                          key === "mega" ? val : currentMegaModel;
                        const nextResponseHandler =
                          key === "responseHandler"
                            ? val
                            : currentResponseHandlerModel;
                        const nextActionPlanner =
                          key === "actionPlanner"
                            ? val
                            : currentActionPlannerModel;
                        if (key === "nano") setCurrentNanoModel(val);
                        if (key === "small") setCurrentSmallModel(val);
                        if (key === "medium") setCurrentMediumModel(val);
                        if (key === "large") setCurrentLargeModel(val);
                        if (key === "mega") setCurrentMegaModel(val);
                        if (key === "responseHandler")
                          setCurrentResponseHandlerModel(val);
                        if (key === "actionPlanner")
                          setCurrentActionPlannerModel(val);
                        void (async () => {
                          setModelSaving(true);
                          try {
                            const cfg = (await client.getConfig()) as Record<
                              string,
                              unknown
                            >;
                            const existingRouting =
                              resolveServiceRoutingInConfig(cfg)?.llmText;
                            const models = {
                              nano: nextNano,
                              small: nextSmall,
                              medium: nextMedium,
                              large: nextLarge,
                              mega: nextMega,
                            };
                            const llmText = buildElizaCloudServiceRoute({
                              nanoModel: nextNano,
                              smallModel: nextSmall,
                              mediumModel: nextMedium,
                              largeModel: nextLarge,
                              megaModel: nextMega,
                              ...(nextResponseHandler !==
                              DEFAULT_RESPONSE_HANDLER_MODEL
                                ? {
                                    responseHandlerModel: nextResponseHandler,
                                  }
                                : {}),
                              ...(nextActionPlanner !==
                              DEFAULT_ACTION_PLANNER_MODEL
                                ? {
                                    actionPlannerModel: nextActionPlanner,
                                  }
                                : {}),
                              ...(existingRouting?.shouldRespondModel
                                ? {
                                    shouldRespondModel:
                                      existingRouting.shouldRespondModel,
                                  }
                                : {}),
                              ...(existingRouting?.plannerModel
                                ? {
                                    plannerModel: existingRouting.plannerModel,
                                  }
                                : {}),
                              ...(existingRouting?.responseModel
                                ? {
                                    responseModel:
                                      existingRouting.responseModel,
                                  }
                                : {}),
                              ...(existingRouting?.mediaDescriptionModel
                                ? {
                                    mediaDescriptionModel:
                                      existingRouting.mediaDescriptionModel,
                                  }
                                : {}),
                            });
                            await client.updateConfig({
                              models,
                              serviceRouting: {
                                ...(((cfg.serviceRouting as Record<
                                  string,
                                  unknown
                                > | null) ?? {}) as Record<string, unknown>),
                                llmText,
                              },
                            });
                            setModelSaveSuccess(true);
                            setTimeout(() => setModelSaveSuccess(false), 2000);
                            await client.restartAgent();
                          } catch (err) {
                            console.warn(
                              "[eliza] Failed to save cloud model config",
                              err,
                            );
                            notifySelectionFailure(
                              "Failed to save cloud model config",
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
                  <span className="text-xs-tight text-muted">
                    {t("providerswitcher.savingRestarting")}
                  </span>
                )}
                {modelSaveSuccess && (
                  <span className="text-xs-tight text-ok">
                    {t("providerswitcher.savedRestartingAgent")}
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs-tight text-muted">
                {t("providerswitcher.restartRequiredHint")}
              </p>
            </div>
          ) : (
            <div>
              {elizaCloudLoginBusy ? (
                <div className="text-xs text-muted">
                  {t("providerswitcher.waitingForBrowser")}
                </div>
              ) : (
                <>
                  {elizaCloudLoginError && (
                    <div className="text-xs text-danger mb-2">
                      {elizaCloudLoginError}
                    </div>
                  )}
                  {elizaCloudLoginError && (
                    <Button
                      variant="link"
                      size="sm"
                      type="button"
                      className="!mt-0 !px-0 text-xs-tight"
                      onClick={() => openExternalUrl(branding.bugReportUrl)}
                    >
                      {t("providerswitcher.reportIssueWithTemplate")}
                    </Button>
                  )}
                  <Button
                    variant="default"
                    size="sm"
                    className="!mt-0 font-bold"
                    onClick={() => void handleCloudLogin()}
                  >
                    {t("providerswitcher.logInToElizaCloud")}
                  </Button>
                  <div className="text-xs-tight text-muted mt-1.5">
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
