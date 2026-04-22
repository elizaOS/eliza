/**
 * ProviderSwitcher — provider picker + model-tier config for the "AI Model"
 * settings section. Composes SubscriptionStatus + ApiKeyConfig.
 *
 * Cloud account details (credits, user id, top-up) intentionally live in
 * the separate "Cloud" settings section — this section is focused on model
 * routing, not billing.
 *
 * **Spacing:** Root stack uses `space-y-4`; cloud sub-blocks use `border-t border-border/40 pt-3`
 * so the provider row and cloud controls stay visually tight with adjacent settings sections
 * (`space-y-5` + `pt-4` made this block feel oddly loose).
 *
 * **Correctness (keep comments in sync when you change behavior):**
 * - **`switchProviderWithTransientRetry`** — After a switch, gateway/runtime restart often returns
 *   **502–504** or network/timeout errors even for valid requests; bounded retries avoid “click again”
 *   false negatives without infinite loops.
 * - **`providerSelectLocked`** — `providerSwitchBusy || agentStatus.state in (starting, restarting)` so
 *   we do not stack `/api/provider/switch` while the server is bouncing (**WHY:** 503 storms + unclear
 *   attribution).
 * - **Radix `Select` clamp ref (`lastClampedProviderSelectValueRef`)** — During `loadPlugins`, merged ids
 *   can briefly omit the active provider while the server still considers it active; Radix throws or
 *   mis-renders if `value` is not an exact `SelectItem` id (**WHY:** avoid snap-to-cloud / remount thrash).
 * - **`resolvedSelectedId` / orphan clear** — Catalog is synchronous; plugin list is eventual; do not
 *   clear selection mid-gap or users “reset to Eliza Cloud” and keys duplicate.
 * - **Hide `ApiKeyConfig` while locked** — `Select` + dense env fields fight for focus during refresh.
 * - **Skip bundled `updateConfig({ useLocalEmbeddingWithCloud })` while locked** — Same config pipeline
 *   as provider switch (**WHY:** races `loadPlugins` / active-provider view).
 */

import { resolveServiceRoutingInConfig } from "@elizaos/shared/contracts/onboarding";
import { buildElizaCloudServiceRoute } from "@elizaos/shared/contracts/service-routing";
import { ELIZA_CLOUD_PUBLIC_HOST } from "@elizaos/shared/eliza-cloud-presets";
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TooltipProvider,
  useTimeout,
} from "@elizaos/ui";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client, type OnboardingOptions, type PluginParamDef } from "../../api";
import { isApiError } from "../../api/client-types-core";
import { ConfigRenderer, defaultRegistry } from "../../config";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import {
  formatOnboardingPluginProviderLabel,
  getOnboardingProviderOption,
  isSubscriptionProviderSelectionId,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  type SubscriptionProviderSelectionId,
} from "../../providers";
import { useApp } from "../../state";
import type { ConfigUiHint } from "../../types";
import { openExternalUrl } from "../../utils";
import { ApiKeyConfig } from "./ApiKeyConfig";
import { buildUnifiedAiProviderPlugins } from "./build-unified-ai-providers";
import {
  buildCloudModelSchema,
  DEFAULT_ACTION_PLANNER_MODEL,
  DEFAULT_CLOUD_TIER_SENTINEL,
  DEFAULT_RESPONSE_HANDLER_MODEL,
  normalizeCloudTierModelForUi,
  resolveCloudTierModelForPersistence,
} from "./cloud-model-schema";
import { SubscriptionStatus } from "./SubscriptionStatus";

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

/** Single Select row when both @elizaos/plugin-local-ai and plugin-ollama are enabled. */
const LOCAL_AI_MERGED_SELECT_ID = "__local_ai_merged__";

/** Gateway / runtime warmup — safe to retry `switchProvider`. */
function isTransientProviderSwitchFailure(err: unknown): boolean {
  if (!isApiError(err)) return false;
  if (err.kind === "network" || err.kind === "timeout") return true;
  const st = err.status;
  return st === 502 || st === 503 || st === 504;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aiProviderOnboardingId(plugin: PluginInfo): string {
  return (
    getOnboardingProviderOption(normalizeAiProviderPluginId(plugin.id))?.id ??
    normalizeAiProviderPluginId(plugin.id)
  );
}

interface ProviderSwitcherProps {
  elizaCloudConnected?: boolean;
  elizaCloudLoginBusy?: boolean;
  elizaCloudLoginError?: string | null;
  plugins?: PluginInfo[];
  pluginSaving?: Set<string>;
  pluginSaveSuccess?: Set<string>;
  loadPlugins?: () => Promise<void>;
  handlePluginConfigSave?: (
    pluginId: string,
    values: Record<string, unknown>,
  ) => void | Promise<void>;
  handleCloudLogin?: () => Promise<void>;
  /**
   * When Eliza Cloud is the selected AI source, Milady-local / GGUF / device
   * settings are hidden elsewhere — keep this in sync so the parent can match.
   */
  onLocalInferenceSettingsVisibilityChange?: (visible: boolean) => void;
  /**
   * When Milady “Local AI” (bundled plugin-local-ai) is the chat source, the
   * separate embedding source strip is hidden — embeddings are configured in
   * the Local models hub.
   */
  onMiladyBundledLocalLlmChange?: (active: boolean) => void;
  /**
   * True when the selected chat LLM is a local stack (Milady Local AI or
   * Ollama) — used to show local AI engine companion controls.
   */
  onAiUsesExternalLocalRuntimesChange?: (active: boolean) => void;
}

function getSubscriptionProviderLabel(
  provider: { id: SubscriptionProviderSelectionId; labelKey: string },
  t: (key: string) => string,
): string {
  const translated = t(provider.labelKey);
  if (translated !== provider.labelKey) return translated;
  return SUBSCRIPTION_PROVIDER_LABEL_FALLBACKS[provider.id] ?? provider.id;
}

export function ProviderSwitcher(props: ProviderSwitcherProps = {}) {
  const { setTimeout } = useTimeout();
  const app = useApp();
  const branding = useBranding();
  const t = app.t;
  const elizaCloudConnected =
    props.elizaCloudConnected ?? Boolean(app.elizaCloudConnected);
  const elizaCloudLoginBusy =
    props.elizaCloudLoginBusy ?? Boolean(app.elizaCloudLoginBusy);
  const elizaCloudLoginError =
    props.elizaCloudLoginError ??
    (typeof app.elizaCloudLoginError === "string"
      ? app.elizaCloudLoginError
      : null);
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
  const onLocalInferenceSettingsVisibilityChange =
    props.onLocalInferenceSettingsVisibilityChange;
  const onMiladyBundledLocalLlmChange = props.onMiladyBundledLocalLlmChange;
  const onAiUsesExternalLocalRuntimesChange =
    props.onAiUsesExternalLocalRuntimesChange;
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
  const [cloudModelTiersOpen, setCloudModelTiersOpen] = useState(false);

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
  const [providerSwitchBusy, setProviderSwitchBusy] = useState(false);

  /** True while API reports agent boot or reload — avoid provider API races (503). */
  const agentRuntimeTransitioning =
    app.agentStatus?.state === "restarting" ||
    app.agentStatus?.state === "starting";
  const providerSelectLocked = providerSwitchBusy || agentRuntimeTransitioning;

  const hasManualSelection = useRef(false);
  /** Last Radix-valid provider `Select` value so we can hold position during loadPlugins gaps. */
  const lastClampedProviderSelectValueRef = useRef<string>("__cloud__");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(
    null,
  );
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
      const transport = llmText?.transport;
      const remoteBase = llmText?.remoteApiBase?.trim();
      const isCloudEliza =
        transport === "cloud-proxy" && providerId === "elizacloud";
      const isRemoteRoute =
        transport === "remote" ||
        Boolean(
          remoteBase && transport !== "direct" && transport !== "cloud-proxy",
        );
      const isDirectRoute =
        transport === "direct" ||
        (transport == null &&
          providerId != null &&
          providerId !== "elizacloud" &&
          !remoteBase);

      const nextSelectedId = isCloudEliza
        ? "__cloud__"
        : isRemoteRoute && providerId
          ? providerId
          : isDirectRoute
            ? (providerId ?? null)
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

        const vars =
          ((cfg.env as Record<string, unknown> | undefined)?.vars as
            | Record<string, unknown>
            | undefined) ?? {};
        const envFor = (key: string) =>
          typeof vars[key] === "string" ? (vars[key] as string) : "";

        setCurrentNanoModel(
          elizaCloudEnabledCfg
            ? normalizeCloudTierModelForUi(
                "nano",
                models?.nano ||
                  llmText?.nanoModel ||
                  envFor("NANO_MODEL") ||
                  "",
                true,
              )
            : models?.nano || llmText?.nanoModel || envFor("NANO_MODEL") || "",
        );
        setCurrentSmallModel(
          elizaCloudEnabledCfg
            ? normalizeCloudTierModelForUi(
                "small",
                models?.small ||
                  llmText?.smallModel ||
                  envFor("SMALL_MODEL") ||
                  "",
                true,
              )
            : models?.small ||
                llmText?.smallModel ||
                envFor("SMALL_MODEL") ||
                "",
        );
        setCurrentMediumModel(
          elizaCloudEnabledCfg
            ? normalizeCloudTierModelForUi(
                "medium",
                models?.medium ||
                  llmText?.mediumModel ||
                  envFor("MEDIUM_MODEL") ||
                  "",
                true,
              )
            : models?.medium ||
                llmText?.mediumModel ||
                envFor("MEDIUM_MODEL") ||
                "",
        );
        setCurrentLargeModel(
          elizaCloudEnabledCfg
            ? normalizeCloudTierModelForUi(
                "large",
                models?.large ||
                  llmText?.largeModel ||
                  envFor("LARGE_MODEL") ||
                  "",
                true,
              )
            : models?.large ||
                llmText?.largeModel ||
                envFor("LARGE_MODEL") ||
                "",
        );
        setCurrentMegaModel(
          elizaCloudEnabledCfg
            ? normalizeCloudTierModelForUi(
                "mega",
                models?.mega ||
                  llmText?.megaModel ||
                  envFor("MEGA_MODEL") ||
                  "",
                true,
              )
            : models?.mega || llmText?.megaModel || envFor("MEGA_MODEL") || "",
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
      buildUnifiedAiProviderPlugins(
        plugins.filter((p) => p.category === "ai-provider"),
        branding.customProviders,
      ),
    [branding.customProviders, plugins],
  );

  const mergeLocalAiRow = useMemo(() => {
    const ids = new Set(allAiProviders.map(aiProviderOnboardingId));
    return {
      shouldMerge: ids.has("ollama") && ids.has("local-ai"),
    };
  }, [allAiProviders]);

  const availableProviderIds = useMemo(
    () =>
      new Set(
        allAiProviders.map((provider) => aiProviderOnboardingId(provider)),
      ),
    [allAiProviders],
  );

  const providerChoices = useMemo(() => {
    const cloudAndSubs = [
      {
        id: "__cloud__",
        label: t("providerswitcher.elizaCloud", {
          cloudPublicHost: ELIZA_CLOUD_PUBLIC_HOST,
          defaultValue: ELIZA_CLOUD_PUBLIC_HOST,
        }),
        disabled: false,
      },
      ...SUBSCRIPTION_PROVIDER_SELECTIONS.map((provider) => ({
        id: provider.id,
        label: getSubscriptionProviderLabel(provider, t),
        disabled: false,
      })),
    ];

    const rows = allAiProviders.map((provider) => ({
      id: aiProviderOnboardingId(provider),
      label: formatOnboardingPluginProviderLabel(provider.id, provider.name, t),
      disabled: false,
    }));

    if (!mergeLocalAiRow.shouldMerge) {
      return [...cloudAndSubs, ...rows];
    }

    const oIdx = rows.findIndex((r) => r.id === "ollama");
    const lIdx = rows.findIndex((r) => r.id === "local-ai");
    const pos = Math.min(
      oIdx === -1 ? Number.POSITIVE_INFINITY : oIdx,
      lIdx === -1 ? Number.POSITIVE_INFINITY : lIdx,
    );
    const filtered = rows.filter(
      (r) => r.id !== "ollama" && r.id !== "local-ai",
    );
    const insertAt = Number.isFinite(pos)
      ? rows
          .slice(0, pos)
          .filter((r) => r.id !== "ollama" && r.id !== "local-ai").length
      : filtered.length;
    const merged = {
      id: LOCAL_AI_MERGED_SELECT_ID,
      label: t("providerswitcher.localAiMerged"),
      disabled: false,
    };
    return [
      ...cloudAndSubs,
      ...filtered.slice(0, insertAt),
      merged,
      ...filtered.slice(insertAt),
    ];
  }, [allAiProviders, mergeLocalAiRow.shouldMerge, t]);

  const providerChoiceIds = useMemo(
    () => new Set(providerChoices.map((c) => c.id)),
    [providerChoices],
  );

  const resolvedSelectedId = useMemo(() => {
    if (selectedProviderId === "__cloud__") return "__cloud__";
    if (!selectedProviderId) return null;
    if (
      availableProviderIds.has(selectedProviderId) ||
      providerChoiceIds.has(selectedProviderId) ||
      isSubscriptionProviderSelectionId(selectedProviderId)
    ) {
      return selectedProviderId;
    }
    /* Keep UI stable while switchProvider + loadPlugins runs or plugins catch up. */
    if (providerSelectLocked) return selectedProviderId;
    if (getOnboardingProviderOption(selectedProviderId.toLowerCase()) != null) {
      return selectedProviderId;
    }
    return null;
  }, [
    availableProviderIds,
    providerChoiceIds,
    providerSelectLocked,
    selectedProviderId,
  ]);

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
        (provider) => aiProviderOnboardingId(provider) === resolvedSelectedId,
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

  /** Agent restart / dev proxy: 502–504, network, timeout — retry so Eliza Cloud / API switches land. */
  const switchProviderWithTransientRetry = useCallback(
    async (
      provider: string,
      apiKey?: string,
      primaryModel?: string,
    ): Promise<void> => {
      const maxAttempts = 14;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await client.switchProvider(provider, apiKey, primaryModel);
          return;
        } catch (err) {
          if (
            isTransientProviderSwitchFailure(err) &&
            attempt < maxAttempts - 1
          ) {
            await delay(400 + 280 * attempt);
            continue;
          }
          throw err;
        }
      }
    },
    [],
  );

  /* ── Handlers ─────────────────────────────────────────────────── */
  const handleSwitchProvider = useCallback(
    async (newId: string) => {
      const previousSelectedId = resolvedSelectedId;
      const previousManualSelection = hasManualSelection.current;
      hasManualSelection.current = true;
      setSelectedProviderId(newId);
      const lookupId = newId === LOCAL_AI_MERGED_SELECT_ID ? "local-ai" : newId;
      const target =
        allAiProviders.find(
          (provider) => aiProviderOnboardingId(provider) === lookupId,
        ) ?? null;
      const providerId =
        getOnboardingProviderOption(
          normalizeAiProviderPluginId(target?.id ?? lookupId),
        )?.id ?? lookupId;

      setProviderSwitchBusy(true);
      try {
        await switchProviderWithTransientRetry(providerId);
        await loadPlugins();
      } catch (err) {
        restoreSelection(previousSelectedId, previousManualSelection);
        notifySelectionFailure("Failed to switch AI provider", err);
      } finally {
        setProviderSwitchBusy(false);
      }
    },
    [
      allAiProviders,
      loadPlugins,
      notifySelectionFailure,
      resolvedSelectedId,
      restoreSelection,
      switchProviderWithTransientRetry,
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
      if (!activate) return;
      setProviderSwitchBusy(true);
      try {
        await switchProviderWithTransientRetry(providerId);
      } catch (err) {
        restoreSelection(previousSelectedId, previousManualSelection);
        notifySelectionFailure("Failed to update subscription provider", err);
      } finally {
        setProviderSwitchBusy(false);
      }
    },
    [
      notifySelectionFailure,
      resolvedSelectedId,
      restoreSelection,
      switchProviderWithTransientRetry,
    ],
  );

  const handleSelectCloud = useCallback(async () => {
    const previousSelectedId = resolvedSelectedId;
    const previousManualSelection = hasManualSelection.current;
    hasManualSelection.current = true;
    setSelectedProviderId("__cloud__");
    setProviderSwitchBusy(true);
    try {
      await switchProviderWithTransientRetry("elizacloud");
    } catch (err) {
      restoreSelection(previousSelectedId, previousManualSelection);
      notifySelectionFailure("Failed to select Eliza Cloud", err);
    } finally {
      setProviderSwitchBusy(false);
    }
  }, [
    notifySelectionFailure,
    resolvedSelectedId,
    restoreSelection,
    switchProviderWithTransientRetry,
  ]);

  /* ── Derived render state ─────────────────────────────────────── */
  const isCloudSelected =
    resolvedSelectedId === "__cloud__" || resolvedSelectedId === null;
  const isSubscriptionSelected =
    isSubscriptionProviderSelectionId(resolvedSelectedId);
  /** Milady “Local AI” / plugin-local-ai — full Local models hub already covers embeddings. */
  const isBundledMiladyLocalLlm =
    (resolvedSelectedId ?? "").toLowerCase() === "local-ai";

  const aiUsesExternalLocalRuntimes = useMemo(() => {
    const id = resolvedSelectedId;
    if (!id || id === "__cloud__" || isSubscriptionProviderSelectionId(id)) {
      return false;
    }
    const opt = getOnboardingProviderOption(id.toLowerCase());
    return opt?.authMode === "local";
  }, [resolvedSelectedId]);

  useEffect(() => {
    onLocalInferenceSettingsVisibilityChange?.(!isCloudSelected);
  }, [isCloudSelected, onLocalInferenceSettingsVisibilityChange]);

  useEffect(() => {
    if (!isCloudSelected) setCloudModelTiersOpen(false);
  }, [isCloudSelected]);

  useEffect(() => {
    onMiladyBundledLocalLlmChange?.(isBundledMiladyLocalLlm);
  }, [isBundledMiladyLocalLlm, onMiladyBundledLocalLlmChange]);

  useEffect(() => {
    onAiUsesExternalLocalRuntimesChange?.(aiUsesExternalLocalRuntimes);
  }, [aiUsesExternalLocalRuntimes, onAiUsesExternalLocalRuntimesChange]);

  useEffect(() => {
    if (!isBundledMiladyLocalLlm) return;
    /* Avoid updateConfig during provider switch — races loadPlugins and confuses the picker. */
    if (providerSelectLocked) return;
    void (async () => {
      try {
        await client.updateConfig({
          ui: { useLocalEmbeddingWithCloud: false },
        });
      } catch {
        /* persist failed — EmbeddingGenerationSettings can retry */
      }
    })();
  }, [isBundledMiladyLocalLlm, providerSelectLocked]);

  const providerSelectValue = useMemo(() => {
    if (resolvedSelectedId === "__cloud__" || resolvedSelectedId === null) {
      return "__cloud__";
    }
    if (
      mergeLocalAiRow.shouldMerge &&
      (resolvedSelectedId === "ollama" || resolvedSelectedId === "local-ai")
    ) {
      return LOCAL_AI_MERGED_SELECT_ID;
    }
    return resolvedSelectedId;
  }, [mergeLocalAiRow.shouldMerge, resolvedSelectedId]);

  /** Radix Select breaks when `value` is not an exact `SelectItem` value (e.g. stale id). */
  const clampedProviderSelectValue = useMemo(() => {
    const desired = providerSelectValue ?? "__cloud__";
    let out: string;
    if (providerChoiceIds.has(desired)) {
      out = desired;
    } else if (
      providerSelectLocked &&
      lastClampedProviderSelectValueRef.current &&
      providerChoiceIds.has(lastClampedProviderSelectValueRef.current)
    ) {
      out = lastClampedProviderSelectValueRef.current;
    } else if (
      resolvedSelectedId &&
      resolvedSelectedId !== "__cloud__" &&
      providerChoiceIds.has(resolvedSelectedId)
    ) {
      out = resolvedSelectedId;
    } else if (providerChoiceIds.has("__cloud__")) {
      out = "__cloud__";
    } else {
      out = providerChoices[0]?.id ?? "__cloud__";
    }
    if (providerChoiceIds.has(out)) {
      lastClampedProviderSelectValueRef.current = out;
    }
    return out;
  }, [
    providerChoiceIds,
    providerChoices,
    providerSelectValue,
    providerSelectLocked,
    resolvedSelectedId,
  ]);

  useEffect(() => {
    if (!selectedProviderId || selectedProviderId === "__cloud__") {
      return;
    }
    if (isSubscriptionProviderSelectionId(selectedProviderId)) {
      return;
    }
    if (providerSelectLocked) {
      return;
    }
    if (providerChoiceIds.has(selectedProviderId)) {
      return;
    }
    /* Merged row uses Select value __local_ai_merged__; state stays ollama | local-ai. */
    if (
      mergeLocalAiRow.shouldMerge &&
      (selectedProviderId === "local-ai" || selectedProviderId === "ollama")
    ) {
      return;
    }
    /* Plugin list can briefly omit rows during loadPlugins — do not wipe a valid pick. */
    if (getOnboardingProviderOption(selectedProviderId.toLowerCase()) != null) {
      return;
    }
    hasManualSelection.current = false;
    setSelectedProviderId(null);
  }, [
    mergeLocalAiRow.shouldMerge,
    providerChoiceIds,
    providerSelectLocked,
    selectedProviderId,
  ]);

  /* ── Cloud-model schema ───────────────────────────────────────── */
  const cloudModelSchema = useMemo(
    () => (modelOptions ? buildCloudModelSchema(modelOptions) : null),
    [modelOptions],
  );

  /** After switching to Eliza Cloud (or loading catalog), align tier values with schema enums. */
  useEffect(() => {
    if (!isCloudSelected || !cloudModelSchema || !elizaCloudConnected) return;
    const properties = cloudModelSchema.schema.properties ?? {};
    const coerce = (
      tier: "nano" | "small" | "medium" | "large" | "mega",
      setModel: (updater: (prev: string) => string) => void,
    ) => {
      setModel((prev) => {
        const allowed = (properties[tier]?.enum as string[] | undefined) ?? [];
        if (!prev || !allowed.includes(prev)) {
          return DEFAULT_CLOUD_TIER_SENTINEL[tier];
        }
        return prev;
      });
    };
    coerce("nano", setCurrentNanoModel);
    coerce("small", setCurrentSmallModel);
    coerce("medium", setCurrentMediumModel);
    coerce("large", setCurrentLargeModel);
    coerce("mega", setCurrentMegaModel);
  }, [isCloudSelected, cloudModelSchema, elizaCloudConnected]);

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
          const cfg = (await client.getConfig()) as Record<string, unknown>;
          const existingRouting = resolveServiceRoutingInConfig(cfg)?.llmText;
          const persistedNano = resolveCloudTierModelForPersistence(
            "nano",
            next.nano,
          );
          const persistedSmall = resolveCloudTierModelForPersistence(
            "small",
            next.small,
          );
          const persistedMedium = resolveCloudTierModelForPersistence(
            "medium",
            next.medium,
          );
          const persistedLarge = resolveCloudTierModelForPersistence(
            "large",
            next.large,
          );
          const persistedMega = resolveCloudTierModelForPersistence(
            "mega",
            next.mega,
          );
          const llmText = buildElizaCloudServiceRoute({
            nanoModel: persistedNano,
            smallModel: persistedSmall,
            mediumModel: persistedMedium,
            largeModel: persistedLarge,
            megaModel: persistedMega,
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
              nano: persistedNano,
              small: persistedSmall,
              medium: persistedMedium,
              large: persistedLarge,
              mega: persistedMega,
            },
            serviceRouting: {
              ...(((cfg.serviceRouting as Record<string, unknown> | null) ??
                {}) as Record<string, unknown>),
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

  /* ── Render ───────────────────────────────────────────────────── */
  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-4">
        {/* Provider dropdown */}
        <div>
          <label
            htmlFor="provider-switcher-select"
            className="mb-1.5 block text-xs font-medium uppercase tracking-wider text-muted"
          >
            {t("providerswitcher.selectAIProvider", {
              defaultValue: "Choose AI provider",
            })}
          </label>
          <Select
            value={clampedProviderSelectValue}
            disabled={providerSelectLocked}
            onValueChange={(nextId: string) => {
              if (providerSelectLocked) {
                return;
              }
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
              if (nextId === LOCAL_AI_MERGED_SELECT_ID) {
                void handleSwitchProvider("local-ai");
                return;
              }
              void handleSwitchProvider(nextId);
            }}
          >
            <SelectTrigger
              id="provider-switcher-select"
              className="h-9 w-full rounded-lg border border-border bg-card text-sm"
              aria-busy={providerSelectLocked}
              title={
                providerSelectLocked
                  ? providerSwitchBusy
                    ? t("providerswitcher.providerSwitchBusy", {
                        defaultValue: "Switching provider…",
                      })
                    : t("providerswitcher.agentRuntimeBusy", {
                        defaultValue: "Agent is starting or restarting…",
                      })
                  : undefined
              }
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
        </div>

        {/* Cloud model tiers (when Cloud is selected) */}
        {isCloudSelected &&
          (!elizaCloudConnected ? (
            <div className="border-t border-border/40 pt-3">
              {elizaCloudLoginBusy ? (
                <div className="text-xs text-muted">
                  {t("providerswitcher.waitingForBrowser")}
                </div>
              ) : (
                <>
                  {elizaCloudLoginError && (
                    <div className="mb-2 text-xs text-danger">
                      {elizaCloudLoginError}
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <Button
                      variant="default"
                      size="sm"
                      className="rounded-lg font-semibold"
                      onClick={() => void handleCloudLogin()}
                    >
                      {t("providerswitcher.logInToElizaCloud")}
                    </Button>
                    {elizaCloudLoginError && (
                      <Button
                        variant="link"
                        size="sm"
                        type="button"
                        className="h-auto p-0 text-xs-tight"
                        onClick={() => openExternalUrl(branding.bugReportUrl)}
                      >
                        {t("providerswitcher.reportIssueWithTemplate")}
                      </Button>
                    )}
                  </div>
                  <div className="mt-1.5 text-xs-tight text-muted">
                    {t("providerswitcher.opensABrowserWindow")}
                  </div>
                </>
              )}
            </div>
          ) : cloudModelSchema ? (
            <div className="border-t border-border/40 pt-3">
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5 text-left transition-colors hover:bg-muted/25 hover:border-border/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  aria-expanded={cloudModelTiersOpen}
                  title={t("providerswitcher.changeCloudDefaultsDesc", {
                    defaultValue:
                      "Advanced: per-tier models. Built-in defaults suit most chats.",
                  })}
                  onClick={() => setCloudModelTiersOpen((o) => !o)}
                >
                  <span className="text-sm font-medium text-foreground">
                    {t("providerswitcher.changeCloudDefaults", {
                      defaultValue: "Change default models",
                    })}
                  </span>
                  <ChevronDown
                    className={`h-4 w-4 shrink-0 text-muted transition-transform ${cloudModelTiersOpen ? "rotate-180" : ""}`}
                    aria-hidden
                  />
                </button>
                {cloudModelTiersOpen ? (
                  <>
                    <ConfigRenderer
                      schema={cloudModelSchema.schema}
                      hints={cloudModelSchema.hints}
                      values={modelValues.values}
                      setKeys={modelValues.setKeys}
                      registry={defaultRegistry}
                      onChange={handleModelFieldChange}
                    />
                    <div className="mt-4 flex items-center justify-between gap-2">
                      <p className="text-xs-tight text-muted">
                        {t("providerswitcher.restartRequiredHint", {
                          ...appNameInterpolationVars(branding),
                          defaultValue:
                            "These Eliza Cloud model settings apply after restart. {{appName}} restarts automatically when you save a change here.",
                        })}
                      </p>
                      <div className="flex items-center gap-2">
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
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ) : null)}

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

        {/* Local provider settings (API keys) — hide during switch so nested fields do not fight the Select. */}
        {!isCloudSelected &&
          !isSubscriptionSelected &&
          !providerSelectLocked && (
            <ApiKeyConfig
              selectedProvider={selectedProvider}
              pluginSaving={pluginSaving}
              pluginSaveSuccess={pluginSaveSuccess}
              handlePluginConfigSave={handlePluginConfigSave}
              loadPlugins={loadPlugins}
              onSaveCatalogApiKey={async (onboardingProviderId, apiKey) => {
                setProviderSwitchBusy(true);
                try {
                  await switchProviderWithTransientRetry(
                    onboardingProviderId,
                    apiKey,
                  );
                  await loadPlugins();
                } finally {
                  setProviderSwitchBusy(false);
                }
              }}
            />
          )}
      </div>
    </TooltipProvider>
  );
}
