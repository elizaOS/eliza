import {
  resolveServiceRoutingInConfig,
  type SubscriptionProviderStatus,
} from "@elizaos/shared";
import { Cloud, Cpu, KeyRound } from "lucide-react";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { client, type PluginParamDef } from "../../api";
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
import { ProvidersList } from "../local-inference/ProvidersList";
import { RoutingMatrix } from "../local-inference/RoutingMatrix";
import {
  ProviderCard,
  type ProviderCategory,
  type ProviderStatus,
} from "./ProviderCard";
import {
  ApiKeyPanel,
  CloudPanel,
  LocalProviderPanel,
  SubscriptionPanel,
} from "./ProviderPanels";
import { AdvancedSettingsDisclosure } from "./settings-control-primitives";
import { useCloudModelConfig } from "./useCloudModelConfig";
import {
  type ProviderPanelId,
  resolveProviderIdForSwitch,
  useProviderSelection,
} from "./useProviderSelection";

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

function getSubscriptionProviderDescription(
  providerId: SubscriptionProviderSelectionId,
): string {
  switch (providerId) {
    case "anthropic-subscription":
      return "Claude Code and task-agent access.";
    case "openai-subscription":
      return "Codex-backed coding access.";
    case "gemini-subscription":
      return "Gemini CLI coding access.";
    case "zai-coding-subscription":
      return "z.ai Coding Plan endpoint.";
    case "kimi-coding-subscription":
      return "Kimi Code endpoint.";
    case "deepseek-coding-subscription":
      return "Unavailable without a first-party coding surface.";
  }
}

interface ProviderListEntry {
  id: ProviderPanelId;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  category: ProviderCategory;
  status: ProviderStatus;
  current: boolean;
}

export function ProviderSwitcher(props: ProviderSwitcherProps = {}) {
  const app = useApp();
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

  const [subscriptionStatus, setSubscriptionStatus] = useState<
    SubscriptionProviderStatus[]
  >([]);
  const [anthropicConnected, setAnthropicConnected] = useState(false);
  const [anthropicCliDetected, setAnthropicCliDetected] = useState(false);
  const [openaiConnected, setOpenaiConnected] = useState(false);

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

  const selection = useProviderSelection(
    availableProviderIds,
    notifySelectionFailure,
  );
  const cloudModel = useCloudModelConfig(notifySelectionFailure);

  const loadSubscriptionStatus = useCallback(async () => {
    try {
      const res = await client.getSubscriptionStatus();
      setSubscriptionStatus(res.providers ?? []);
    } catch (err) {
      console.warn("[eliza] Failed to load subscription status", err);
    }
  }, []);

  // Boot effect. Hooks own their internal state; calling their stable
  // setters in this once-on-mount effect is intentional. Biome wants the
  // setter identities in the dep list but we know they're stable.
  // biome-ignore lint/correctness/useExhaustiveDependencies: stable hook setters
  useEffect(() => {
    void loadSubscriptionStatus();
    void (async () => {
      try {
        const opts = await client.getOnboardingOptions();
        cloudModel.setModelOptions({
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
        const llmText = resolveServiceRoutingInConfig(cfg)?.llmText;
        const providerId = getOnboardingProviderOption(llmText?.backend)?.id;
        const elizaCloudEnabledCfg =
          llmText?.transport === "cloud-proxy" && providerId === "elizacloud";
        cloudModel.initializeFromConfig(cfg, elizaCloudEnabledCfg);
        selection.initializeFromConfig(cfg);
      } catch (err) {
        console.warn("[eliza] Failed to load config", err);
      }
    })();
  }, [loadSubscriptionStatus]);

  useEffect(() => {
    const anthStatuses = subscriptionStatus.filter(
      (s) => s.provider === "anthropic-subscription",
    );
    const oaiStatuses = subscriptionStatus.filter(
      (s) =>
        s.provider === "openai-subscription" || s.provider === "openai-codex",
    );
    // Only treat as "connected" when credentials were linked via the in-app
    // OAuth flow (source === "app"). Claude Code CLI credentials detected on
    // the machine are surfaced separately — the app can't disconnect them.
    const anthAppConnected = anthStatuses.some(
      (status) => status.configured && status.valid && status.source === "app",
    );
    setAnthropicConnected(anthAppConnected);
    setAnthropicCliDetected(
      anthStatuses.some(
        (status) =>
          status.configured &&
          status.valid &&
          status.source === "claude-code-cli",
      ),
    );
    setOpenaiConnected(
      oaiStatuses.some((status) => status.configured && status.valid),
    );
  }, [subscriptionStatus]);

  const apiProviderChoices = useMemo(() => {
    const pluginChoices = allAiProviders
      .map((provider) => {
        const option = getOnboardingProviderOption(
          normalizeAiProviderPluginId(provider.id),
        );
        return option ? { id: option.id, label: option.name, provider } : null;
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

  const visibleProviderPanelId = selection.visibleProviderPanelId;
  const resolvedSelectedId = selection.resolvedSelectedId;

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

  /**
   * Single source of truth for sidebar entry status.
   * Replaces three diverging functions (Cloud/Local hardcoded rows,
   * getSubscriptionPanelStatus, inline apiProviderChoices status).
   */
  const getProviderStatus = useCallback(
    (entryId: ProviderPanelId): ProviderStatus => {
      if (entryId === "__cloud__") {
        return elizaCloudConnected
          ? { tone: "ok", label: "Connected" }
          : { tone: "muted", label: "Available" };
      }
      if (entryId === "__local__") {
        return selection.cloudCallsDisabled
          ? { tone: "ok", label: "Active" }
          : { tone: "muted", label: "Available" };
      }
      if (isSubscriptionProviderSelectionId(entryId)) {
        const subSelection = SUBSCRIPTION_PROVIDER_SELECTIONS.find(
          (provider) => provider.id === entryId,
        );
        const statuses = subscriptionStatus.filter(
          (entry) =>
            entry.provider === entryId ||
            (subSelection
              ? entry.provider === subSelection.storedProvider
              : false),
        );
        if (
          statuses.length > 0 &&
          statuses.every((status) => status.available === false)
        ) {
          return { tone: "warn", label: "Unavailable" };
        }
        if (entryId === "anthropic-subscription" && anthropicCliDetected) {
          return { tone: "ok", label: "CLI detected" };
        }
        if (
          entryId === "gemini-subscription" &&
          statuses.some(
            (status) =>
              status.source === "gemini-cli" &&
              status.configured &&
              status.valid,
          )
        ) {
          return { tone: "ok", label: "CLI detected" };
        }
        if (statuses.some((status) => status.configured && status.valid)) {
          return { tone: "ok", label: "Connected" };
        }
        if (statuses.some((status) => status.configured && !status.valid)) {
          return { tone: "warn", label: "Needs repair" };
        }
        return { tone: "muted", label: "Not connected" };
      }
      const choice = apiProviderChoices.find((c) => c.id === entryId);
      if (!choice) return { tone: "muted", label: "Available" };
      return choice.provider.configured
        ? { tone: "ok", label: "API key set" }
        : { tone: "warn", label: "Needs key" };
    },
    [
      anthropicCliDetected,
      apiProviderChoices,
      elizaCloudConnected,
      selection.cloudCallsDisabled,
      subscriptionStatus,
    ],
  );

  const providerEntries = useMemo<ProviderListEntry[]>(() => {
    const entries: ProviderListEntry[] = [];
    entries.push({
      id: "__cloud__",
      icon: Cloud,
      label: "Eliza Cloud",
      category: "cloud",
      status: getProviderStatus("__cloud__"),
      current: !selection.cloudCallsDisabled && selection.isCloudSelected,
    });
    for (const provider of SUBSCRIPTION_PROVIDER_SELECTIONS) {
      entries.push({
        id: provider.id,
        icon: KeyRound,
        label: t(provider.labelKey, { defaultValue: provider.id }),
        category: "subscription",
        status: getProviderStatus(provider.id),
        current:
          !selection.cloudCallsDisabled && resolvedSelectedId === provider.id,
      });
    }
    entries.push({
      id: "__local__",
      icon: Cpu,
      label: "Local provider",
      category: "local",
      status: getProviderStatus("__local__"),
      current: selection.cloudCallsDisabled,
    });
    for (const choice of apiProviderChoices) {
      entries.push({
        id: choice.id,
        icon: KeyRound,
        label: choice.label,
        category: "key",
        status: getProviderStatus(choice.id),
        current:
          !selection.cloudCallsDisabled && resolvedSelectedId === choice.id,
      });
    }
    return entries;
  }, [
    apiProviderChoices,
    getProviderStatus,
    resolvedSelectedId,
    selection.cloudCallsDisabled,
    selection.isCloudSelected,
    t,
  ]);

  const activeSubscriptionSelection = useMemo(
    () =>
      isSubscriptionProviderSelectionId(visibleProviderPanelId)
        ? (SUBSCRIPTION_PROVIDER_SELECTIONS.find(
            (provider) => provider.id === visibleProviderPanelId,
          ) ?? null)
        : null,
    [visibleProviderPanelId],
  );

  const apiKeyPanelLabel =
    apiProviderChoices.find((choice) => choice.id === visibleProviderPanelId)
      ?.label ??
    selectedPanelProvider?.name ??
    "";

  const onSwitchProvider = useCallback(
    (id: string) => {
      void selection.handleSwitchProvider(
        id,
        resolveProviderIdForSwitch(id, allAiProviders),
      );
    },
    [allAiProviders, selection],
  );

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-[minmax(0,260px)_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-1.5">
          {providerEntries.map((entry) => (
            <ProviderCard
              key={entry.id}
              id={entry.id}
              icon={entry.icon}
              label={entry.label}
              category={entry.category}
              status={entry.status}
              current={entry.current}
              selected={visibleProviderPanelId === entry.id}
              onSelect={selection.handleProviderPanelSelect}
            />
          ))}
        </aside>

        <section className="min-w-0 rounded-xl border border-border/40 bg-card/35">
          {visibleProviderPanelId === "__local__" ? (
            <LocalProviderPanel
              cloudCallsDisabled={selection.cloudCallsDisabled}
              routingModeSaving={selection.routingModeSaving}
              onSelectLocalOnly={() => void selection.handleSelectLocalOnly()}
            />
          ) : null}

          {visibleProviderPanelId === "__cloud__" ? (
            <CloudPanel
              cloudCallsDisabled={selection.cloudCallsDisabled}
              isCloudSelected={selection.isCloudSelected}
              routingModeSaving={selection.routingModeSaving}
              onSelectCloud={() => void selection.handleSelectCloud()}
              elizaCloudConnected={elizaCloudConnected}
              largeModelOptions={cloudModel.largeModelOptions}
              cloudModelSchema={cloudModel.cloudModelSchema}
              modelValues={cloudModel.modelValues}
              currentLargeModel={cloudModel.currentLargeModel}
              modelSaving={cloudModel.modelSaving}
              modelSaveSuccess={cloudModel.modelSaveSuccess}
              onModelFieldChange={cloudModel.handleModelFieldChange}
              localEmbeddings={selection.localEmbeddings}
              onToggleLocalEmbeddings={(v) =>
                void selection.handleToggleLocalEmbeddings(v)
              }
            />
          ) : null}

          {activeSubscriptionSelection ? (
            <SubscriptionPanel
              selection={activeSubscriptionSelection}
              description={getSubscriptionProviderDescription(
                activeSubscriptionSelection.id,
              )}
              visibleProviderPanelId={visibleProviderPanelId}
              resolvedSelectedId={resolvedSelectedId}
              cloudCallsDisabled={selection.cloudCallsDisabled}
              subscriptionStatus={subscriptionStatus}
              anthropicConnected={anthropicConnected}
              setAnthropicConnected={setAnthropicConnected}
              anthropicCliDetected={anthropicCliDetected}
              openaiConnected={openaiConnected}
              setOpenaiConnected={setOpenaiConnected}
              onSelectSubscription={selection.handleSelectSubscription}
              loadSubscriptionStatus={loadSubscriptionStatus}
            />
          ) : null}

          {selectedPanelProvider ? (
            <ApiKeyPanel
              selectedProvider={selectedPanelProvider}
              panelLabel={apiKeyPanelLabel}
              visibleProviderPanelId={visibleProviderPanelId}
              resolvedSelectedId={resolvedSelectedId}
              cloudCallsDisabled={selection.cloudCallsDisabled}
              selectedPanelAccountProvider={selectedPanelAccountProvider}
              onSwitchProvider={onSwitchProvider}
              pluginSaving={pluginSaving}
              pluginSaveSuccess={pluginSaveSuccess}
              handlePluginConfigSave={handlePluginConfigSave}
              loadPlugins={loadPlugins}
            />
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
