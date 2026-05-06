import {
  asRecord,
  buildElizaCloudServiceRoute,
  DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
  normalizeServiceRoutingConfig,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import {
  Button,
  Checkbox,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  TooltipHint,
  useTimeout,
} from "@elizaos/ui";
import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Cloud,
  Cpu,
  KeyRound,
  Loader2,
  ShieldCheck,
} from "lucide-react";
import {
  type ComponentType,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { client, type OnboardingOptions, type PluginParamDef } from "../../api";
import {
  ConfigRenderer,
  defaultRegistry,
} from "../../components/config-ui/config-renderer";
import { appNameInterpolationVars, useBranding } from "../../config/branding";
import {
  getDirectAccountProviderForOnboardingProvider,
  getOnboardingProviderOption,
  isSubscriptionProviderSelectionId,
  ONBOARDING_PROVIDER_CATALOG,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  type SubscriptionProviderSelectionId,
} from "../../providers";
import { useApp } from "../../state";
import type { ConfigUiHint } from "../../types";
import { AccountList } from "../accounts/AccountList";
import { LocalInferencePanel } from "../local-inference/LocalInferencePanel";
import { ProvidersList } from "../local-inference/ProvidersList";
import { RoutingMatrix } from "../local-inference/RoutingMatrix";
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

type ProviderPanelId = "__cloud__" | "__local__" | string;
type ProviderListItemTone = "ok" | "warn" | "muted";

const PROVIDER_LIST_STATUS_ICON_CLASSES: Record<ProviderListItemTone, string> =
  {
    ok: "text-ok",
    warn: "text-warn",
    muted: "text-muted",
  };

function ProviderStatusGlyph({
  current,
  status,
  tone,
}: {
  current: boolean;
  status: string;
  tone: ProviderListItemTone;
}) {
  const label = current ? "Active" : status;
  const Icon =
    current || tone === "ok"
      ? CheckCircle2
      : tone === "warn"
        ? AlertCircle
        : Circle;
  const iconClass = current
    ? "text-accent"
    : PROVIDER_LIST_STATUS_ICON_CLASSES[tone];

  return (
    <span
      className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${iconClass}`}
      title={label}
      aria-hidden
    >
      <Icon className="h-3.5 w-3.5" />
    </span>
  );
}

function ProviderListItem({
  id,
  icon: Icon,
  label,
  description,
  selected,
  current,
  status,
  tone,
  onSelect,
}: {
  id: ProviderPanelId;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  description: string;
  selected: boolean;
  current: boolean;
  status: string;
  tone: ProviderListItemTone;
  onSelect: (id: ProviderPanelId) => void;
}) {
  const stateLabel = current ? "Active" : status;

  return (
    <button
      type="button"
      aria-current={selected ? "true" : undefined}
      aria-label={`${label}, ${stateLabel}`}
      onClick={() => onSelect(id)}
      title={`${label} · ${stateLabel} · ${description}`}
      className={`flex h-10 w-full items-center gap-2 rounded-lg border px-2 text-left transition-colors ${
        selected
          ? "border-accent/45 bg-accent/10"
          : "border-border/45 bg-card/35 hover:border-border hover:bg-card/70"
      }`}
    >
      <span
        className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
          current ? "bg-accent/10 text-accent" : "bg-bg/60 text-muted"
        }`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-txt">
        {label}
      </span>
      <ProviderStatusGlyph current={current} status={status} tone={tone} />
    </button>
  );
}

function ProviderPanelHeader({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header
      className="flex min-h-12 items-center justify-between gap-3 border-border/40 border-b px-3 py-2 sm:px-4"
      title={description}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-bg/50 text-muted">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 className="truncate font-semibold text-sm text-txt">{title}</h3>
        </div>
      </div>
      {children ? <div className="shrink-0">{children}</div> : null}
    </header>
  );
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
  // true = embeddings stay local (cloud embeddings route absent from config).
  // Pre-checked when the loaded config has no embeddings service route.
  const [localEmbeddings, setLocalEmbeddings] = useState(false);

  const [subscriptionStatus, setSubscriptionStatus] = useState<
    Array<{
      provider: string;
      accountId: string;
      label: string;
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
  const hasManualPanelSelection = useRef(false);
  const [selectedProviderPanelId, setSelectedProviderPanelId] =
    useState<ProviderPanelId | null>(null);

  const readCloudCallsDisabled = useCallback(
    (cfg: Record<string, unknown>): boolean => {
      const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
      if (
        llmText?.transport === "cloud-proxy" ||
        llmText?.transport === "direct" ||
        llmText?.transport === "remote"
      ) {
        return false;
      }
      const cloud = asRecord(cfg.cloud);
      const services = asRecord(cloud?.services);
      return Boolean(
        cloud?.inferenceMode === "local" || services?.inference === false,
      );
    },
    [],
  );

  // Returns true when the cloud embeddings route is absent — meaning embeddings
  // are kept local. Pre-checks the "Use local embeddings" toggle in Settings.
  const readLocalEmbeddingsFromConfig = useCallback(
    (cfg: Record<string, unknown>): boolean => {
      const embeddings = resolveServiceRoutingInConfig(cfg)?.embeddings;
      if (embeddings === undefined) return true;
      // Cloud proxy route explicitly set → embeddings are going to the cloud.
      return !(
        embeddings.transport === "cloud-proxy" &&
        embeddings.backend === "elizacloud"
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
      setLocalEmbeddings(readLocalEmbeddingsFromConfig(cfg));
    },
    [readCloudCallsDisabled, readLocalEmbeddingsFromConfig],
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
          nano: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
          small: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
          medium: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
          large: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
          mega: DEFAULT_ELIZA_CLOUD_TEXT_MODEL,
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
        [
          ...allAiProviders.map(
            (provider) =>
              getOnboardingProviderOption(
                normalizeAiProviderPluginId(provider.id),
              )?.id,
          ),
          ...ONBOARDING_PROVIDER_CATALOG.filter(
            (option) =>
              option.authMode === "api-key" &&
              getDirectAccountProviderForOnboardingProvider(option.id),
          ).map((option) => option.id),
        ].filter((id): id is NonNullable<typeof id> => id != null),
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
      const previousCloudCallsDisabled = cloudCallsDisabled;
      hasManualSelection.current = true;
      setSelectedProviderId(newId);
      setCloudCallsDisabled(false);
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
        setCloudCallsDisabled(previousCloudCallsDisabled);
        notifySelectionFailure("Failed to switch AI provider", err);
      }
    },
    [
      allAiProviders,
      cloudCallsDisabled,
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
      const previousCloudCallsDisabled = cloudCallsDisabled;
      hasManualSelection.current = true;
      setSelectedProviderId(providerId);
      if (!activate) return;
      setCloudCallsDisabled(false);
      try {
        await client.switchProvider(providerId);
      } catch (err) {
        restoreSelection(previousSelectedId, previousManualSelection);
        setCloudCallsDisabled(previousCloudCallsDisabled);
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
      // Route through the canonical cloud disconnect path so we get the full
      // teardown (POST /api/cloud/disconnect → cloudManager.disconnect(),
      // delete cloud.apiKey, applyCanonicalOnboardingConfig with
      // linkedAccounts.elizacloud=unlinked + clearRoutes, env wipe, runtime
      // character-secrets wipe) plus the renderer-side state reset
      // (elizaCloud{Enabled,Connected,Credits,UserId,...} all flipped). The
      // previous bespoke client.updateConfig({ cloud: { enabled: false, ... } })
      // toggled flags but left cloud.apiKey, linkedAccounts, env vars and
      // runtime secrets intact, so the next "use cloud" path silently reused
      // stale state. skipConfirmation: true because clicking "Use local only"
      // IS the confirmation — no need for a second dialog.
      await app.handleCloudDisconnect({ skipConfirmation: true });
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
    app,
    cloudCallsDisabled,
    notifySelectionFailure,
    resolvedSelectedId,
    restoreSelection,
  ]);

  const handleToggleLocalEmbeddings = useCallback(
    async (nextValue: boolean) => {
      const previous = localEmbeddings;
      setLocalEmbeddings(nextValue);
      try {
        await client.switchProvider("elizacloud", undefined, undefined, {
          useLocalEmbeddings: nextValue,
        });
      } catch (err) {
        setLocalEmbeddings(previous);
        notifySelectionFailure("Failed to update embeddings preference", err);
      }
    },
    [localEmbeddings, notifySelectionFailure],
  );

  const isCloudSelected =
    resolvedSelectedId === "__cloud__" || resolvedSelectedId === null;
  const activeProviderPanelId: ProviderPanelId = cloudCallsDisabled
    ? "__local__"
    : (resolvedSelectedId ?? "__cloud__");
  const visibleProviderPanelId: ProviderPanelId =
    selectedProviderPanelId ?? activeProviderPanelId;

  useEffect(() => {
    if (hasManualPanelSelection.current) return;
    setSelectedProviderPanelId(activeProviderPanelId);
  }, [activeProviderPanelId]);

  const apiProviderChoices = useMemo(() => {
    const pluginChoices = allAiProviders
      .map((provider) => {
        const option = getOnboardingProviderOption(
          normalizeAiProviderPluginId(provider.id),
        );
        return option
          ? {
              id: option.id,
              label: option.name,
              provider,
            }
          : null;
      })
      .filter(
        (choice): choice is NonNullable<typeof choice> => choice !== null,
      );
    const seen = new Set(pluginChoices.map((choice) => choice.id));
    const accountManagedChoices = ONBOARDING_PROVIDER_CATALOG.filter(
      (option) =>
        option.authMode === "api-key" &&
        getDirectAccountProviderForOnboardingProvider(option.id) &&
        !seen.has(option.id),
    ).map((option) => ({
      id: option.id,
      label: option.name,
      provider: {
        id: option.id,
        name: option.name,
        category: "ai-provider",
        enabled: false,
        configured: false,
        parameters: [],
      } satisfies PluginInfo,
    }));
    return [...pluginChoices, ...accountManagedChoices].sort((left, right) => {
      const leftOrder =
        getOnboardingProviderOption(left.id)?.order ?? Number.MAX_SAFE_INTEGER;
      const rightOrder =
        getOnboardingProviderOption(right.id)?.order ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder;
    });
  }, [allAiProviders]);

  const selectedPanelProvider = useMemo(() => {
    if (
      visibleProviderPanelId === "__cloud__" ||
      visibleProviderPanelId === "__local__" ||
      isSubscriptionProviderSelectionId(visibleProviderPanelId)
    ) {
      return null;
    }
    return (
      apiProviderChoices.find((choice) => choice.id === visibleProviderPanelId)
        ?.provider ?? null
    );
  }, [apiProviderChoices, visibleProviderPanelId]);
  const selectedPanelAccountProvider = useMemo(
    () => getDirectAccountProviderForOnboardingProvider(visibleProviderPanelId),
    [visibleProviderPanelId],
  );

  const getSubscriptionPanelStatus = useCallback(
    (providerId: SubscriptionProviderSelectionId) => {
      const status = subscriptionStatus.find((entry) =>
        providerId === "openai-subscription"
          ? entry.provider === "openai-subscription" ||
            entry.provider === "openai-codex"
          : entry.provider === providerId,
      );
      if (providerId === "anthropic-subscription" && anthropicCliDetected) {
        return { label: "CLI detected", tone: "ok" as const };
      }
      if (status?.configured && status.valid) {
        return { label: "Connected", tone: "ok" as const };
      }
      if (status?.configured && !status.valid) {
        return { label: "Needs repair", tone: "warn" as const };
      }
      return { label: "Not connected", tone: "muted" as const };
    },
    [anthropicCliDetected, subscriptionStatus],
  );

  const handleProviderPanelSelect = useCallback((panelId: ProviderPanelId) => {
    hasManualPanelSelection.current = true;
    setSelectedProviderPanelId(panelId);
  }, []);

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
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-3">
          <div className="space-y-1.5">
            <div className="text-[10px] text-muted font-medium uppercase tracking-wider">
              Providers
            </div>
            <ProviderListItem
              id="__cloud__"
              icon={Cloud}
              label="Eliza Cloud"
              description="Managed models, credits, and cloud fallback."
              selected={visibleProviderPanelId === "__cloud__"}
              current={!cloudCallsDisabled && isCloudSelected}
              status={elizaCloudConnected ? "Connected" : "Available"}
              tone={elizaCloudConnected ? "ok" : "muted"}
              onSelect={handleProviderPanelSelect}
            />
            <ProviderListItem
              id="__local__"
              icon={Cpu}
              label="Local provider"
              description="Downloaded models, routing, and offline inference."
              selected={visibleProviderPanelId === "__local__"}
              current={cloudCallsDisabled}
              status="Available"
              tone="muted"
              onSelect={handleProviderPanelSelect}
            />
          </div>

          <div className="space-y-1.5">
            <div className="text-[10px] text-muted font-medium uppercase tracking-wider">
              Subscriptions
            </div>
            {SUBSCRIPTION_PROVIDER_SELECTIONS.map((provider) => {
              const status = getSubscriptionPanelStatus(provider.id);
              return (
                <ProviderListItem
                  key={provider.id}
                  id={provider.id}
                  icon={KeyRound}
                  label={getSubscriptionProviderLabel(provider, t)}
                  description={
                    provider.id === "anthropic-subscription"
                      ? "Claude Code and task-agent access."
                      : "ChatGPT/Codex subscription access."
                  }
                  selected={visibleProviderPanelId === provider.id}
                  current={
                    !cloudCallsDisabled && resolvedSelectedId === provider.id
                  }
                  status={status.label}
                  tone={status.tone}
                  onSelect={handleProviderPanelSelect}
                />
              );
            })}
          </div>

          {apiProviderChoices.length > 0 ? (
            <div className="space-y-1.5">
              <div className="text-[10px] text-muted font-medium uppercase tracking-wider">
                API keys
              </div>
              {apiProviderChoices.map((choice) => {
                const current =
                  !cloudCallsDisabled && resolvedSelectedId === choice.id;
                const status = choice.provider.configured
                  ? "API key set"
                  : choice.provider.enabled
                    ? "Enabled"
                    : "Needs key";
                const tone: ProviderListItemTone = choice.provider.configured
                  ? "ok"
                  : "warn";
                return (
                  <ProviderListItem
                    key={choice.id}
                    id={choice.id}
                    icon={KeyRound}
                    label={choice.label}
                    description={choice.provider.name}
                    selected={visibleProviderPanelId === choice.id}
                    current={current}
                    status={status}
                    tone={tone}
                    onSelect={handleProviderPanelSelect}
                  />
                );
              })}
            </div>
          ) : null}
        </aside>

        <section className="min-w-0 overflow-hidden rounded-xl border border-border/40 bg-card/35">
          {visibleProviderPanelId === "__local__" ? (
            <div className="min-w-0">
              <ProviderPanelHeader
                icon={Cpu}
                title="Local provider"
                description="Manage local downloads, active models, routing, and device pairing in one place."
              >
                <Button
                  type="button"
                  variant={cloudCallsDisabled ? "default" : "outline"}
                  className="h-8 rounded-lg px-2.5 text-xs"
                  disabled={routingModeSaving}
                  aria-label={
                    cloudCallsDisabled ? "Local only active" : "Use local only"
                  }
                  onClick={() => void handleSelectLocalOnly()}
                >
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                  Local only
                </Button>
              </ProviderPanelHeader>
              <div className="px-3 py-3 sm:px-4">
                <LocalInferencePanel />
              </div>
            </div>
          ) : null}

          {visibleProviderPanelId === "__cloud__" ? (
            <div className="min-w-0">
              <ProviderPanelHeader
                icon={Cloud}
                title="Eliza Cloud"
                description="Use managed models, cloud routing, and account credits."
              >
                <Button
                  type="button"
                  variant={
                    !cloudCallsDisabled && isCloudSelected
                      ? "default"
                      : "outline"
                  }
                  className="h-8 rounded-lg px-2.5 text-xs"
                  disabled={routingModeSaving}
                  aria-label={
                    !cloudCallsDisabled && isCloudSelected
                      ? "Cloud active"
                      : "Use Eliza Cloud"
                  }
                  onClick={() => void handleSelectCloud()}
                >
                  <Cloud className="h-4 w-4" aria-hidden />
                  Cloud
                </Button>
              </ProviderPanelHeader>
              <CloudDashboard />
              {!cloudCallsDisabled && isCloudSelected ? (
                <div className="border-border/40 border-t px-4 py-3 sm:px-5">
                  <LocalEmbeddingsCheckbox
                    checked={localEmbeddings}
                    onCheckedChange={(v) => void handleToggleLocalEmbeddings(v)}
                  />
                </div>
              ) : null}
              {!cloudCallsDisabled &&
              isCloudSelected &&
              elizaCloudConnected &&
              (largeModelOptions.length > 0 || cloudModelSchema) ? (
                <div className="border-border/40 border-t px-4 py-4 sm:px-5">
                  {largeModelOptions.length > 0 ? (
                    <div>
                      <label
                        htmlFor="provider-switcher-primary-model"
                        className="mb-1.5 block text-muted text-xs font-medium uppercase tracking-wider"
                      >
                        {t("providerswitcher.model", { defaultValue: "Model" })}
                      </label>
                      <Select
                        value={currentLargeModel || ""}
                        onValueChange={(v) =>
                          handleModelFieldChange("large", v)
                        }
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
                    <p className="text-muted text-xs-tight">
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
                          aria-label={t(
                            "providerswitcher.savedRestartingAgent",
                          )}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {isSubscriptionProviderSelectionId(visibleProviderPanelId) ? (
            <div className="min-w-0">
              <ProviderPanelHeader
                icon={KeyRound}
                title={getSubscriptionProviderLabel(
                  SUBSCRIPTION_PROVIDER_SELECTIONS.find(
                    (provider) => provider.id === visibleProviderPanelId,
                  ) ?? SUBSCRIPTION_PROVIDER_SELECTIONS[0],
                  t,
                )}
                description="Connect subscription-backed access for models and task agents."
              >
                {cloudCallsDisabled ||
                resolvedSelectedId !== visibleProviderPanelId ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 rounded-lg px-2.5 text-xs"
                    onClick={() =>
                      void handleSelectSubscription(
                        visibleProviderPanelId as SubscriptionProviderSelectionId,
                      )
                    }
                  >
                    Use subscription
                  </Button>
                ) : null}
              </ProviderPanelHeader>
              <div className="px-3 py-3 sm:px-4">
                {cloudCallsDisabled ? (
                  <div className="mb-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs-tight">
                    Local-only active. Remote subscription routing is paused.
                  </div>
                ) : null}
                <SubscriptionStatus
                  resolvedSelectedId={visibleProviderPanelId}
                  subscriptionStatus={subscriptionStatus}
                  anthropicConnected={anthropicConnected}
                  setAnthropicConnected={setAnthropicConnected}
                  anthropicCliDetected={anthropicCliDetected}
                  openaiConnected={openaiConnected}
                  setOpenaiConnected={setOpenaiConnected}
                  handleSelectSubscription={handleSelectSubscription}
                  loadSubscriptionStatus={loadSubscriptionStatus}
                />
                {(() => {
                  const selection = SUBSCRIPTION_PROVIDER_SELECTIONS.find(
                    (p) => p.id === visibleProviderPanelId,
                  );
                  // The outer `isSubscriptionProviderSelectionId` guard
                  // makes this lookup non-null in practice; the explicit
                  // null check is defensive against future panel ids
                  // that pass the guard but aren't in the selections
                  // table (e.g. a renamed enum left half-migrated).
                  if (!selection) return null;
                  return <AccountList providerId={selection.storedProvider} />;
                })()}
              </div>
            </div>
          ) : null}

          {selectedPanelProvider ? (
            <div className="min-w-0">
              <ProviderPanelHeader
                icon={KeyRound}
                title={
                  apiProviderChoices.find(
                    (choice) => choice.id === visibleProviderPanelId,
                  )?.label ?? selectedPanelProvider.name
                }
                description="Use your own provider API key and model routing."
              >
                {cloudCallsDisabled ||
                resolvedSelectedId !== visibleProviderPanelId ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-8 rounded-lg px-2.5 text-xs"
                    onClick={() =>
                      void handleSwitchProvider(visibleProviderPanelId)
                    }
                  >
                    Use provider
                  </Button>
                ) : null}
              </ProviderPanelHeader>
              <div className="px-3 py-3 sm:px-4">
                {cloudCallsDisabled ? (
                  <div className="mb-3 rounded-lg border border-warn/30 bg-warn/5 px-3 py-2 text-warn text-xs-tight">
                    Local-only active. Remote API routing is paused.
                  </div>
                ) : null}
                <ApiKeyConfig
                  selectedProvider={selectedPanelProvider}
                  pluginSaving={pluginSaving}
                  pluginSaveSuccess={pluginSaveSuccess}
                  handlePluginConfigSave={handlePluginConfigSave}
                  loadPlugins={loadPlugins}
                />
                {selectedPanelAccountProvider ? (
                  <AccountList providerId={selectedPanelAccountProvider} />
                ) : null}
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <AdvancedSettingsDisclosure title="Model settings">
        <div className="flex flex-col gap-3">
          <ProvidersList />
          <RoutingMatrix />
        </div>
      </AdvancedSettingsDisclosure>
    </div>
  );
}

const LOCAL_EMBEDDINGS_TOOLTIP =
  "Embeddings are vector representations of your messages, used for memory and search. Keeping them local means your message text isn't sent to the cloud just to compute vectors. Chat still goes through the cloud.";

function LocalEmbeddingsCheckbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5 py-1">
      <Checkbox
        id="provider-switcher-local-embeddings"
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        className="mt-0.5 shrink-0"
        aria-label="Use local embeddings"
      />
      <div className="flex min-w-0 items-center gap-1.5">
        <label
          htmlFor="provider-switcher-local-embeddings"
          className="cursor-pointer text-xs-tight text-txt select-none"
        >
          Use local embeddings
        </label>
        <TooltipHint content={LOCAL_EMBEDDINGS_TOOLTIP} side="top">
          <span
            className="inline-flex h-4 w-4 shrink-0 cursor-help items-center justify-center rounded-full border border-border/40 text-2xs text-muted hover:text-txt"
            aria-hidden="true"
          >
            ?
          </span>
        </TooltipHint>
      </div>
    </div>
  );
}
