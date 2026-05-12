import { useCallback, useMemo } from "react";
import {
  getDirectAccountProviderForOnboardingProvider,
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
import { useCloudModelConfig } from "./useCloudModelConfig";
import { useProviderBootstrap } from "./useProviderBootstrap";
import {
  computeAvailableProviderIds,
  type PluginInfo,
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
