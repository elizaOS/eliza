import { useCallback, useMemo } from "react";
import { useDefaultProviderPresets } from "../../hooks/useDefaultProviderPresets";
import {
  getDirectAccountProviderForFirstRunProvider,
  isSubscriptionProviderSelectionId,
  SUBSCRIPTION_PROVIDER_SELECTIONS,
  type SubscriptionProviderSelectionId,
} from "../../providers";
import { useApp } from "../../state";
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
import { SettingsGroup, SettingsStack } from "./settings-layout";
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

export function ProviderSwitcher(props: ProviderSwitcherProps = {}) {
  const app = useApp();
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

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("providerswitcher.providerGroupTitle", {
          defaultValue: "Provider",
        })}
        description={t("providerswitcher.providerGroupDesc", {
          defaultValue: "Where this agent's intelligence comes from.",
        })}
        bare
      >
        {activeEntry ? (
          <ActiveProviderSummary entry={activeEntry} t={t} />
        ) : null}
        <div className="flex flex-wrap gap-2">
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
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={t("providerswitcher.configGroupTitle", {
          defaultValue: "Configuration",
        })}
        className="min-w-0"
      >
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

        {activeSubscriptionSelection ? (
          <SubscriptionPanel
            selection={activeSubscriptionSelection}
            description={getSubscriptionProviderDescription(
              activeSubscriptionSelection.id,
            )}
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
      </SettingsGroup>

      <SettingsGroup
        title={t("providerswitcher.advancedGroupTitle", {
          defaultValue: "Advanced",
        })}
        bare
      >
        <AdvancedSettingsDisclosure
          title={t("providerswitcher.modelSettings", {
            defaultValue: "Model routing & devices",
          })}
          lazy
        >
          <div className="flex flex-col gap-3">
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
 * anchored summary above the chip cloud so "what's powering me right now" is
 * answered without scanning every chip for the filled/active state.
 */
function ActiveProviderSummary({
  entry,
  t,
}: {
  entry: ProviderListEntry;
  t: (key: string, vars?: Record<string, unknown>) => string;
}) {
  const Icon = entry.icon;
  return (
    <div className="mb-3 flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/8 px-3 py-2.5">
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/12 text-accent ring-1 ring-accent/20">
        <Icon className="h-[18px] w-[18px]" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-accent">
          {t("providerswitcher.activeProvider", { defaultValue: "Active" })}
        </p>
        <p className="truncate text-sm font-medium leading-5 text-txt-strong">
          {entry.label}
        </p>
      </div>
      <span className="shrink-0 text-xs text-muted">{entry.status.label}</span>
    </div>
  );
}
