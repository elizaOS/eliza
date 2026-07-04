/**
 * Settings → "Models & Providers" section (the `ai-model` section id). Thin
 * compositional shell that wires the provider hooks
 * (useProviderEntries/useProviderSelection/useProviderBootstrap/
 * useCloudModelConfig) to the presentational pieces: the ProviderCard grid, the
 * per-provider panels (cloud tier dropdowns, API-key form, local models), and
 * the routing matrix. `ActiveProviderSummary` renders the single active-provider
 * row for other surfaces. Section body lazy-loaded via settings-sections.ts.
 */

import { useCallback, useMemo } from "react";
import { useDefaultProviderPresets } from "../../hooks/useDefaultProviderPresets";
import {
  getDirectAccountProviderForFirstRunProvider,
  isSubscriptionProviderSelectionId,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
} from "../../providers";
import { useAppSelectorShallow } from "../../state";
import { ProvidersList } from "../local-inference/ProvidersList";
import { RoutingMatrix } from "../local-inference/RoutingMatrix";
import { ProviderCard } from "./ProviderCard";
import {
  ApiKeyPanel,
  CloudPanel,
  LocalProviderPanel,
  SubscriptionPanel,
} from "./ProviderPanels";
import { AdvancedSettingsDisclosure } from "./settings-control-primitives";
import { SettingsGroup, SettingsRow, SettingsStack } from "./settings-layout";
import { useCloudModelConfig } from "./useCloudModelConfig";
import { useProviderBootstrap } from "./useProviderBootstrap";
import {
  computeAvailableProviderIds,
  type PluginInfo,
  type ProviderListEntry,
  sortAiProviders,
  useProviderEntries,
} from "./useProviderEntries";
import {
  resolveProviderIdForSwitch,
  useProviderSelection,
} from "./useProviderSelection";

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

export function ProviderSwitcher(props: ProviderSwitcherProps = {}) {
  const app = useAppSelectorShallow((s) => ({
    t: s.t,
    elizaCloudConnected: s.elizaCloudConnected,
    plugins: s.plugins,
    pluginSaving: s.pluginSaving,
    pluginSaveSuccess: s.pluginSaveSuccess,
    loadPlugins: s.loadPlugins,
    handlePluginConfigSave: s.handlePluginConfigSave,
    setActionNotice: s.setActionNotice,
  }));
  const t = app.t;
  // Warm the runtime-mode default voice/ASR cache for the Voice section.
  useDefaultProviderPresets();
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

  const allAiProviders = useMemo(() => sortAiProviders(plugins), [plugins]);
  const availableProviderIds = useMemo(
    () => computeAvailableProviderIds(allAiProviders),
    [allAiProviders],
  );

  const selection = useProviderSelection(
    availableProviderIds,
    notifySelectionFailure,
  );
  const cloudModel = useCloudModelConfig(notifySelectionFailure);
  const bootstrap = useProviderBootstrap(selection, cloudModel);

  const { apiProviderChoices, providerEntries } = useProviderEntries({
    allAiProviders,
    elizaCloudConnected,
    cloudCallsDisabled: selection.cloudCallsDisabled,
    isCloudSelected: selection.isCloudSelected,
    resolvedSelectedId: selection.resolvedSelectedId,
    subscriptionStatus: bootstrap.subscriptionStatus,
    anthropicCliDetected: bootstrap.anthropicCliDetected,
    t,
  });

  const { visibleProviderPanelId, resolvedSelectedId } = selection;

  const activeEntry = useMemo(
    () => providerEntries.find((entry) => entry.current) ?? null,
    [providerEntries],
  );

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
    () => getDirectAccountProviderForFirstRunProvider(visibleProviderPanelId),
    [visibleProviderPanelId],
  );

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

  // Split the providers by purpose so the page reads as two simple "just works"
  // decisions — the agent's brain (Local/Cloud) up top, the coding/workflow
  // subscriptions (Claude/Codex/z.ai) in their own group — with custom keys and
  // per-slot overrides tucked into Advanced.
  const intelligenceEntries = providerEntries.filter(
    (entry) => entry.category === "cloud" || entry.category === "local",
  );
  const subscriptionEntries = providerEntries.filter(
    (entry) => entry.category === "subscription",
  );
  const keyEntries = providerEntries.filter(
    (entry) => entry.category === "key",
  );

  const renderChip = (entry: ProviderListEntry) => (
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
  );

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("providerswitcher.intelligenceGroupTitle", {
          defaultValue: "Intelligence",
        })}
        bare
      >
        {activeEntry ? (
          <ActiveProviderSummary entry={activeEntry} t={t} />
        ) : null}
        <div className="flex flex-wrap gap-2">
          {intelligenceEntries.map(renderChip)}
        </div>

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
          />
        ) : null}
      </SettingsGroup>

      {subscriptionEntries.length > 0 ? (
        <SettingsGroup
          title={t("providerswitcher.orchestratorGroupTitle", {
            defaultValue: "Code orchestrator & workflows",
          })}
          bare
        >
          <div className="flex flex-wrap gap-2">
            {subscriptionEntries.map(renderChip)}
          </div>

          {activeSubscriptionSelection ? (
            <SubscriptionPanel
              selection={activeSubscriptionSelection}
              visibleProviderPanelId={visibleProviderPanelId}
              resolvedSelectedId={resolvedSelectedId}
              cloudCallsDisabled={selection.cloudCallsDisabled}
              subscriptionStatus={bootstrap.subscriptionStatus}
              anthropicConnected={bootstrap.anthropicConnected}
              setAnthropicConnected={bootstrap.setAnthropicConnected}
              anthropicCliDetected={bootstrap.anthropicCliDetected}
              openaiConnected={bootstrap.openaiConnected}
              setOpenaiConnected={bootstrap.setOpenaiConnected}
              onSelectSubscription={selection.handleSelectSubscription}
              loadSubscriptionStatus={bootstrap.loadSubscriptionStatus}
            />
          ) : null}
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title={t("providerswitcher.advancedGroupTitle", {
          defaultValue: "Advanced",
        })}
        bare
      >
        <AdvancedSettingsDisclosure
          title={t("providerswitcher.advancedDisclosureTitle", {
            defaultValue: "Custom providers & model overrides",
          })}
          lazy
        >
          <div className="flex flex-col gap-3">
            {keyEntries.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {keyEntries.map(renderChip)}
              </div>
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

            <ProvidersList />
            <RoutingMatrix />
          </div>
        </AdvancedSettingsDisclosure>
      </SettingsGroup>
    </SettingsStack>
  );
}

/**
 * The provider currently routing this agent's intelligence, surfaced as a single
 * anchored row above the chip cloud so "what's powering me right now" is answered
 * without scanning every chip for the filled/active state.
 *
 * Honesty note: most coding-plan subscriptions (Claude Subscription, Gemini/
 * z.ai/Kimi/DeepSeek coding plans) can be the "current" selection WITHOUT
 * routing the main chat inference — `applySubscriptionProviderConfig`
 * (packages/agent/src/api/provider-switch-config.ts) records them for the
 * task-agent orchestrator and only sets a runtime `model.primary` for the
 * Codex plan (`openai-codex`). A bare "Active" here therefore read as "this
 * now powers chat", which is false for Claude. Those entries get a qualified
 * label + note so the summary states what the selection actually does; the
 * Codex plan (which really can power the runtime) keeps the plain label.
 *
 * @internal Exported for testing only.
 */
export function ActiveProviderSummary({
  entry,
  t,
}: {
  entry: ProviderListEntry;
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const Icon = entry.icon;
  // Mirrors the `runtimeApplicable` rule in provider-switch-config.ts: of the
  // subscription selections only openai-codex may drive runtime inference.
  const codingAgentsOnly =
    entry.category === "subscription" && entry.id !== "openai-subscription";
  return (
    <SettingsRow
      label={
        <span className="flex items-center gap-2">
          <Icon
            className="h-[18px] w-[18px] shrink-0 text-accent"
            aria-hidden
          />
          {entry.label}
        </span>
      }
      description={
        codingAgentsOnly
          ? t("providerswitcher.codingSubscriptionChatNote", {
              defaultValue:
                "Powers coding agents & workflows only — chat replies keep using your selected Intelligence provider (Cloud or Local).",
            })
          : undefined
      }
      control={
        <span className="text-xs text-accent">
          {codingAgentsOnly
            ? t("providerswitcher.activeProviderCodingAgents", {
                defaultValue: "Active for coding agents",
              })
            : t("providerswitcher.activeProvider", { defaultValue: "Active" })}
        </span>
      }
    />
  );
}
