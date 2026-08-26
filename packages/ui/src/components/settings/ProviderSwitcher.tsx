/**
 * Composes provider discovery, selection, account enrollment, model routing,
 * and voice status into the Models & Providers settings section. Hooks own
 * runtime state; this surface keeps the provider panels presentational.
 */

import type { LinkedAccountProviderId } from "@elizaos/shared";
import { Mic } from "lucide-react";
import { useCallback, useMemo } from "react";
import { useDefaultProviderPresets } from "../../hooks/useDefaultProviderPresets";
import {
  FIRST_RUN_PROVIDER_CATALOG,
  getDirectAccountProviderForFirstRunProvider,
  isSubscriptionProviderSelectionId,
} from "../../providers";
import { useAppSelectorShallow } from "../../state";
import { claimCloudLoginWindow } from "../../state/cloud-login-launch";
import { AccountManagementPanel } from "../accounts/AccountManagementPanel";
import { ProvidersList } from "../local-inference/ProvidersList";
import { RoutingMatrix } from "../local-inference/RoutingMatrix";
import { IntelligenceServingSummary } from "./IntelligenceServingSummary";
import { ModelConfigurationPanel } from "./ModelConfigurationPanel";
import { ProviderCard } from "./ProviderCard";
import { ApiKeyPanel, CloudPanel, LocalProviderPanel } from "./ProviderPanels";
import type { ServingAxes } from "./resolveServingAxes";
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
import { useServingAxes } from "./useServingAxes";

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
    handleInteractiveCloudLogin: s.handleInteractiveCloudLogin,
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
  const handleInteractiveCloudLogin = app.handleInteractiveCloudLogin;

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
    elizaCloudConnected,
  );
  const cloudModel = useCloudModelConfig(notifySelectionFailure);
  const bootstrap = useProviderBootstrap(
    selection,
    cloudModel,
    !selection.cloudRuntimeLocked,
  );

  const { apiProviderChoices, providerEntries, servingLocalFallback } =
    useProviderEntries({
      allAiProviders,
      elizaCloudConnected,
      cloudCallsDisabled: selection.cloudCallsDisabled,
      isCloudSelected: selection.isCloudSelected,
      isCloudConfigured: selection.isCloudConfigured,
      resolvedSelectedId: selection.resolvedSelectedId,
      subscriptionStatus: bootstrap.subscriptionStatus,
      anthropicCliDetected: bootstrap.anthropicCliDetected,
      t,
    });

  const { visibleProviderPanelId, resolvedSelectedId } = selection;

  // The tiles below only answer "who computes chat replies?". Runtime is the
  // other, independent axis — without it a hosted Cloud agent and a local
  // agent on Cloud models are indistinguishable here.
  const servingAxes = useServingAxes({
    elizaCloudConnected,
    isCloudSelected: selection.isCloudSelected,
    cloudCallsDisabled: selection.cloudCallsDisabled,
  });

  const displayedProviderEntries = useMemo(
    () => reconcileProviderEntriesWithServingAxes(providerEntries, servingAxes),
    [providerEntries, servingAxes],
  );

  const activeEntry = useMemo(
    () => displayedProviderEntries.find((entry) => entry.current) ?? null,
    [displayedProviderEntries],
  );

  const activeChatCatalogProvider = resolveActiveChatCatalogProvider(
    resolvedSelectedId,
    elizaCloudConnected,
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

  const apiKeyPanelLabel =
    apiProviderChoices.find((choice) => choice.id === visibleProviderPanelId)
      ?.label ??
    selectedPanelProvider?.name ??
    "";

  const handleCloudSignIn = useCallback(() => {
    // Keep the popup user-activation alive across the async login start.
    claimCloudLoginWindow();
    void handleInteractiveCloudLogin?.().catch((error: unknown) => {
      // error-policy:J4 Login failed; keep Settings usable and show the notice.
      setActionNotice?.(
        error instanceof Error ? error.message : "Could not start Cloud login.",
        "error",
        5000,
      );
    });
  }, [handleInteractiveCloudLogin, setActionNotice]);

  const onSwitchProvider = useCallback(
    (id: string) => {
      void selection.handleSwitchProvider(
        id,
        resolveProviderIdForSwitch(id, allAiProviders),
      );
    },
    [allAiProviders, selection],
  );

  const activeChatProviderId =
    getDirectAccountProviderForFirstRunProvider(resolvedSelectedId);
  const onSelectChatProvider = useCallback(
    (accountProviderId: LinkedAccountProviderId) => {
      const provider = FIRST_RUN_PROVIDER_CATALOG.find(
        (candidate) =>
          getDirectAccountProviderForFirstRunProvider(candidate.id) ===
          accountProviderId,
      );
      if (!provider) {
        setActionNotice?.(
          "This account provider cannot be selected for chat.",
          "error",
          6000,
        );
        return;
      }
      void selection.handleSwitchProvider(
        provider.id,
        resolveProviderIdForSwitch(provider.id, allAiProviders),
      );
    },
    [allAiProviders, selection, setActionNotice],
  );

  // Split the providers by purpose so the page reads as two simple "just works"
  // decisions — the agent's brain (Local/Cloud) up top, the coding/workflow
  // subscriptions (Claude/Codex/z.ai) in their own group — with custom keys and
  // per-slot overrides tucked into Advanced.
  const intelligenceEntries = displayedProviderEntries.filter(
    (entry) =>
      entry.category === "cloud" ||
      (entry.category === "local" && !selection.cloudRuntimeLocked),
  );
  const keyEntries = displayedProviderEntries.filter(
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

  // The two top-level choices earn a one-line explanation each so first-run
  // setup is "pick one of two cards", not "decode a chip cloud".
  const intelligenceDescription = (entry: ProviderListEntry) =>
    entry.category === "cloud"
      ? elizaCloudConnected
        ? t("providerswitcher.cloudTileDescription", {
            defaultValue:
              "Managed models through your Eliza Cloud account. No setup — sign in and it works.",
          })
        : t("providerswitcher.cloudTileUnsignedDescription", {
            defaultValue:
              "Sign in to use managed models. Your current chat provider stays active until you switch.",
          })
      : t("providerswitcher.localTileDescription", {
          defaultValue:
            "Runs entirely on this device with the bundled local model. Private and works offline.",
        });

  return (
    <SettingsStack>
      <SettingsGroup
        title={t("providerswitcher.intelligenceGroupTitle", {
          defaultValue: "Intelligence",
        })}
        description={t("providerswitcher.intelligenceGroupDescription", {
          defaultValue:
            "Agent runtime and chat inference are separate. The tiles below pick inference — the Active source is answering chat. Open a tile to inspect or switch.",
        })}
        bare
      >
        <IntelligenceServingSummary axes={servingAxes} t={t} />

        {/* Subscription-active needs the honesty clarifier (it does NOT route
            chat); a Cloud/Local active state is already shown on its tile. */}
        {!selection.cloudRuntimeLocked &&
        activeEntry &&
        activeEntry.category === "subscription" ? (
          <ActiveProviderSummary entry={activeEntry} t={t} />
        ) : null}
        {!selection.cloudRuntimeLocked ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {intelligenceEntries.map((entry) => (
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
                variant="tile"
                description={intelligenceDescription(entry)}
              />
            ))}
          </div>
        ) : null}

        {visibleProviderPanelId === "__local__" &&
        !selection.cloudRuntimeLocked ? (
          <LocalProviderPanel
            cloudCallsDisabled={
              selection.cloudCallsDisabled && servingAxes.inference === "local"
            }
            routingModeSaving={selection.routingModeSaving}
            onSelectLocalOnly={() => void selection.handleSelectLocalOnly()}
            servingFallback={Boolean(servingLocalFallback)}
          />
        ) : null}

        {visibleProviderPanelId === "__cloud__" &&
        !selection.cloudRuntimeLocked ? (
          <CloudPanel
            cloudCallsDisabled={selection.cloudCallsDisabled}
            isCloudSelected={selection.isCloudConfigured}
            routingModeSaving={selection.routingModeSaving}
            onSelectCloud={() => void selection.handleSelectCloud()}
            onSignIn={handleCloudSignIn}
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

      {/* Per-role model configuration (small/large chat brains + coding
          sub-agent), driven by the validated /api/models catalog. */}
      {!selection.cloudRuntimeLocked ? (
        <ModelConfigurationPanel
          activeChatProvider={activeChatCatalogProvider}
        />
      ) : null}

      {!selection.cloudRuntimeLocked ? (
        <SettingsGroup
          title={t("providerswitcher.accountsGroupTitle", {
            defaultValue: "Accounts",
          })}
          description={t("providerswitcher.accountsGroupDescription", {
            defaultValue:
              "Connect provider accounts without scattering provider pickers across the page.",
          })}
          bare
        >
          <AccountManagementPanel
            activeChatProviderId={activeChatProviderId}
            activeSubscriptionId={
              isSubscriptionProviderSelectionId(resolvedSelectedId)
                ? resolvedSelectedId
                : null
            }
            cloudCallsDisabled={selection.cloudCallsDisabled}
            onSelectChatProvider={onSelectChatProvider}
            onSelectSubscription={selection.handleSelectSubscription}
          />
        </SettingsGroup>
      ) : null}

      {/* Voice folds into this section for MVP (the standalone Voice tab is
          developer-only): speech is pinned to the bundled Kokoro TTS, so a
          read-only status row is the whole story. */}
      <SettingsGroup
        title={t("providerswitcher.voiceGroupTitle", { defaultValue: "Voice" })}
        bare
      >
        <SettingsRow
          label={
            <span className="flex items-center gap-2">
              <Mic className="size-[18px] shrink-0 text-accent" aria-hidden />
              {selection.cloudRuntimeLocked
                ? t("providerswitcher.cloudVoiceRowLabel", {
                    defaultValue: "Eliza Cloud voice",
                  })
                : t("providerswitcher.voiceRowLabel", {
                    defaultValue: "Kokoro (on-device)",
                  })}
            </span>
          }
          description={
            selection.cloudRuntimeLocked
              ? t("providerswitcher.cloudVoiceRowDescription", {
                  defaultValue:
                    "Speech recognition and playback use your signed-in Eliza Cloud service. This app does not download a local voice model.",
                })
              : t("providerswitcher.voiceRowDescription", {
                  defaultValue:
                    "Speech uses the bundled Kokoro voice — nothing to configure. Voice selection moves to your character.",
                })
          }
          control={
            <span className="text-xs text-accent">
              {t("providerswitcher.activeProvider", { defaultValue: "Active" })}
            </span>
          }
        />
      </SettingsGroup>

      {!selection.cloudRuntimeLocked ? (
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
      ) : null}
    </SettingsStack>
  );
}

/**
 * Selection state says what is configured; the serving axes say what actually
 * answered chat. When a direct external provider is serving, do not leave the
 * Local or Cloud tile labelled Active merely because that routing toggle is
 * still selected. Mark a matching key-provider entry active when one exists.
 *
 * @internal Exported for focused settings tests only.
 */
export function reconcileProviderEntriesWithServingAxes(
  entries: ProviderListEntry[],
  axes: ServingAxes,
): ProviderListEntry[] {
  if (axes.inference !== "external") return entries;
  const providerId = axes.activeChatProvider?.trim().toLowerCase() ?? "";
  return entries.map((entry) => {
    const current =
      entry.category === "key" && entry.id.trim().toLowerCase() === providerId;
    const selectedInferenceTile =
      entry.category === "local" || entry.category === "cloud";
    return {
      ...entry,
      current,
      ...(selectedInferenceTile && entry.status.label === "Active"
        ? { status: { tone: "muted" as const, label: "Available" } }
        : {}),
    };
  });
}

/**
 * Catalog chat provider implied by the current intelligence selection.
 * Cloud only pins when the account is actually connected — a cloud-proxy
 * config without a signed-in session falls through to local inference and
 * must not lock the model panel to Eliza Cloud / Gemma 4 31B (#20045).
 *
 * @internal Exported for testing only.
 */
export function resolveActiveChatCatalogProvider(
  resolvedSelectedId: string | null,
  elizaCloudConnected: boolean,
): "elizacloud" | "cerebras" | "claude-chat" | undefined {
  if (resolvedSelectedId === "__cloud__") {
    return elizaCloudConnected ? "elizacloud" : undefined;
  }
  if (resolvedSelectedId === "cerebras") return "cerebras";
  if (resolvedSelectedId === "anthropic") return "claude-chat";
  return undefined;
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
          <Icon className="size-[18px] shrink-0 text-accent" aria-hidden />
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
