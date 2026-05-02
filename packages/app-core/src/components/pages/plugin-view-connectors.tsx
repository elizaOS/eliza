import {
  Button,
  PagePanel,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Switch,
} from "@elizaos/ui";
import { AlertCircle, CheckCircle2, ChevronRight } from "lucide-react";
import { type ReactNode, type RefCallback, useState } from "react";
import {
  type CloudCompatAgent,
  type CloudOAuthConnectionRole,
  client,
  type PluginInfo,
} from "../../api";
import { useApp } from "../../state";
import {
  ConnectorModeSelector,
  useConnectorMode,
} from "../connectors/ConnectorModeSelector";
import {
  ConnectorSetupPanel,
  hasConnectorSetupPanel,
} from "../connectors/ConnectorSetupPanel";
import { getBrandIcon } from "../conversations/brand-icons";
import {
  buildManagedDiscordSettingsReturnUrl,
  resolveManagedDiscordAgentChoice,
} from "./cloud-dashboard-utils";
import { PluginConfigForm, TelegramPluginConfig } from "./PluginConfigForm";
import {
  getPluginResourceLinks,
  pluginResourceLinkLabel,
  SUBGROUP_LABELS,
  subgroupForPlugin,
  type TranslateFn,
} from "./plugin-list-utils";

export interface PluginConnectionTestResult {
  durationMs: number;
  error?: string;
  loading: boolean;
  message?: string;
  success: boolean;
}

interface ConnectorPluginGroupsProps {
  collapseLabel: string;
  connectorExpandedIds: Set<string>;
  connectorInstallPrompt: string;
  connectorSelectedId: string | null;
  expandLabel: string;
  formatSaveSettingsLabel: (isSaving: boolean, didSave: boolean) => string;
  formatTestConnectionLabel: (result?: PluginConnectionTestResult) => string;
  handleConfigReset: (pluginId: string) => void;
  handleConfigSave: (pluginId: string) => Promise<void>;
  handleConnectorExpandedChange: (
    pluginId: string,
    nextExpanded: boolean,
  ) => void;
  handleConnectorSectionToggle: (pluginId: string) => void;
  handleInstallPlugin: (pluginId: string, npmName: string) => Promise<void>;
  handleOpenPluginExternalUrl: (url: string) => Promise<void>;
  handleParamChange: (
    pluginId: string,
    paramKey: string,
    value: string,
  ) => void;
  handleTestConnection: (pluginId: string) => Promise<void>;
  handleTogglePlugin: (pluginId: string, enabled: boolean) => Promise<void>;
  hasPluginToggleInFlight: boolean;
  installPluginLabel: string;
  installProgress: Map<string, { message: string; phase: string }>;
  installingPlugins: Set<string>;
  installProgressLabel: (message?: string) => string;
  loadFailedLabel: string;
  needsSetupLabel: string;
  noConfigurationNeededLabel: string;
  notInstalledLabel: string;
  pluginConfigs: Record<string, Record<string, string>>;
  pluginDescriptionFallback: string;
  pluginSaveSuccess: Set<string>;
  pluginSaving: Set<string>;
  readyLabel: string;
  registerConnectorContentItem: (pluginId: string) => RefCallback<HTMLElement>;
  renderResolvedIcon: (
    plugin: PluginInfo,
    options?: {
      className?: string;
      emojiClassName?: string;
    },
  ) => ReactNode;
  t: TranslateFn;
  testResults: Map<string, PluginConnectionTestResult>;
  togglingPlugins: Set<string>;
  visiblePlugins: PluginInfo[];
}

interface ConnectorPluginCardProps
  extends Omit<ConnectorPluginGroupsProps, "visiblePlugins"> {
  plugin: PluginInfo;
}

type CloudOAuthConnectorCopy = {
  platform: "slack" | "twitter";
  connectionRole: CloudOAuthConnectionRole;
  buttonLabel: string;
  connectedHint: string;
  disconnectedHint: string;
  successNotice: string;
};

const CLOUD_OAUTH_CONNECTORS: Record<string, CloudOAuthConnectorCopy> = {
  slack: {
    platform: "slack",
    connectionRole: "agent",
    buttonLabel: "Use Slack OAuth",
    connectedHint:
      "Connect Slack with Eliza Cloud OAuth. Cloud stores the workspace token and the Slack plugin remains the runtime surface for messages and actions.",
    disconnectedHint:
      "Connect Eliza Cloud first to use Slack OAuth instead of local Socket Mode tokens.",
    successNotice: "Finish Slack OAuth in your browser, then return here.",
  },
  twitter: {
    platform: "twitter",
    connectionRole: "agent",
    buttonLabel: "Use X/Twitter OAuth",
    connectedHint:
      "Connect X/Twitter with Eliza Cloud OAuth so agent posts, mentions, replies, and DMs use the plugin through cloud-held tokens.",
    disconnectedHint:
      "Connect Eliza Cloud first to use X/Twitter OAuth instead of local developer tokens.",
    successNotice: "Finish X/Twitter OAuth in your browser, then return here.",
  },
};

function getCloudOAuthConnector(
  pluginId: string,
  selectedMode: string,
): CloudOAuthConnectorCopy | null {
  if (selectedMode !== "oauth") {
    return null;
  }
  return CLOUD_OAUTH_CONNECTORS[pluginId] ?? null;
}

function groupVisiblePlugins(visiblePlugins: PluginInfo[]) {
  const groupMap = new Map<string, PluginInfo[]>();
  const groupOrder: string[] = [];

  for (const plugin of visiblePlugins) {
    const subgroupId = subgroupForPlugin(plugin);
    if (!groupMap.has(subgroupId)) {
      groupMap.set(subgroupId, []);
      groupOrder.push(subgroupId);
    }
    groupMap.get(subgroupId)?.push(plugin);
  }

  return groupOrder.flatMap((subgroupId) => {
    const plugins = groupMap.get(subgroupId);
    if (!plugins) return [];
    return [
      {
        id: subgroupId,
        label: SUBGROUP_LABELS[subgroupId] ?? subgroupId,
        plugins,
      },
    ];
  });
}

function ConnectorPluginCard({
  collapseLabel,
  connectorExpandedIds,
  connectorInstallPrompt,
  connectorSelectedId,
  expandLabel,
  formatSaveSettingsLabel,
  formatTestConnectionLabel,
  handleConfigReset,
  handleConfigSave,
  handleConnectorExpandedChange,
  handleConnectorSectionToggle,
  handleInstallPlugin,
  handleOpenPluginExternalUrl,
  handleParamChange,
  handleTestConnection,
  handleTogglePlugin,
  hasPluginToggleInFlight,
  installPluginLabel,
  installProgress,
  installingPlugins,
  installProgressLabel,
  loadFailedLabel,
  needsSetupLabel,
  noConfigurationNeededLabel,
  notInstalledLabel,
  plugin,
  pluginConfigs,
  pluginDescriptionFallback,
  pluginSaveSuccess,
  pluginSaving,
  readyLabel,
  registerConnectorContentItem,
  renderResolvedIcon,
  t,
  testResults,
  togglingPlugins,
}: ConnectorPluginCardProps) {
  const { elizaCloudConnected, setActionNotice, setState, setTab } = useApp();
  const connectorMode = useConnectorMode(plugin.id, { elizaCloudConnected });
  const [managedDiscordBusy, setManagedDiscordBusy] = useState(false);
  const [cloudOAuthBusy, setCloudOAuthBusy] = useState(false);
  const [managedDiscordAgents, setManagedDiscordAgents] = useState<
    CloudCompatAgent[]
  >([]);
  const [managedDiscordPickerOpen, setManagedDiscordPickerOpen] =
    useState(false);
  const [managedDiscordSelectedAgentId, setManagedDiscordSelectedAgentId] =
    useState<string | null>(null);
  const selectedCloudOAuthConnector = getCloudOAuthConnector(
    plugin.id,
    connectorMode.selectedMode,
  );
  const cloudOAuthConnector =
    selectedCloudOAuthConnector ??
    (!elizaCloudConnected ? (CLOUD_OAUTH_CONNECTORS[plugin.id] ?? null) : null);
  const isCloudOAuthMode = Boolean(selectedCloudOAuthConnector);
  const isDiscordManagedMode =
    plugin.id === "discord" && connectorMode.selectedMode === "managed";
  const isTelegramCloudGatewayMode =
    plugin.id === "telegram" && connectorMode.selectedMode === "cloud-bot";
  const showTelegramCloudGatewayNotice =
    isTelegramCloudGatewayMode ||
    (!elizaCloudConnected && plugin.id === "telegram");
  const cloudBackedConnectorMode =
    elizaCloudConnected && (isCloudOAuthMode || isDiscordManagedMode);
  const hasParams =
    (plugin.parameters?.length ?? 0) > 0 && plugin.id !== "__ui-showcase__";
  const isExpanded = connectorExpandedIds.has(plugin.id);
  const isSelected = connectorSelectedId === plugin.id;
  const requiredParams = hasParams
    ? plugin.parameters.filter((param) => param.required)
    : [];
  const requiredSetCount = requiredParams.filter((param) => param.isSet).length;
  const setCount = hasParams
    ? plugin.parameters.filter((param) => param.isSet).length
    : 0;
  const totalCount = hasParams ? plugin.parameters.length : 0;
  // A connector is considered "Ready" when every **required** param is set.
  // Plugins that only expose optional knobs (e.g. plugin-imessage, whose
  // parameters are all advanced overrides) should flip to Ready as soon as
  // they're enabled, not force the user to fill in every optional field.
  const allParamsSet =
    cloudBackedConnectorMode ||
    !hasParams ||
    requiredSetCount === requiredParams.length;
  const isToggleBusy = togglingPlugins.has(plugin.id);
  const toggleDisabled =
    isToggleBusy || (hasPluginToggleInFlight && !isToggleBusy);
  const isSaving = pluginSaving.has(plugin.id);
  const saveSuccess = pluginSaveSuccess.has(plugin.id);
  const testResult = testResults.get(plugin.id);
  const notLoadedLabel = t("pluginsview.NotLoaded", {
    defaultValue: "Not loaded",
  });
  const isStoreInstallMissing =
    plugin.source === "store" &&
    plugin.enabled &&
    !plugin.isActive &&
    Boolean(plugin.npmName);
  const inactiveLabel = plugin.loadError
    ? loadFailedLabel
    : plugin.source === "store"
      ? notInstalledLabel
      : notLoadedLabel;
  const pluginLinks = getPluginResourceLinks(plugin, {
    draftConfig: pluginConfigs[plugin.id],
  });
  const openCloudAgentsView = () => {
    setState("cloudDashboardView", "overview");
    setTab("settings");
  };
  const ensureManagedDiscordGatewayProvisioned = async (
    agent: CloudCompatAgent,
  ): Promise<boolean> => {
    if (agent.status === "running") {
      return false;
    }

    const provisionResponse = await client.provisionCloudCompatAgent(
      agent.agent_id,
    );
    if (!provisionResponse.success) {
      throw new Error(
        provisionResponse.error ||
          t("pluginsview.ManagedDiscordGatewayProvisionFailed", {
            defaultValue:
              "Failed to start the shared Discord gateway in Eliza Cloud.",
          }),
      );
    }

    return provisionResponse.data?.status !== "running";
  };
  const startManagedDiscordOauth = async (
    agent: CloudCompatAgent,
    options?: { gatewayDeploying?: boolean },
  ) => {
    const oauthResponse =
      await client.createCloudCompatAgentManagedDiscordOauth(agent.agent_id, {
        returnUrl:
          typeof window !== "undefined"
            ? (buildManagedDiscordSettingsReturnUrl(window.location.href) ??
              undefined)
            : undefined,
        botNickname: agent.agent_name?.trim() || undefined,
      });

    await handleOpenPluginExternalUrl(oauthResponse.data.authorizeUrl);
    setManagedDiscordPickerOpen(false);
    setActionNotice(
      t("elizaclouddashboard.DiscordSetupContinuesInBrowser", {
        defaultValue: options?.gatewayDeploying
          ? "Finish Discord setup in your browser, then wait for the shared Discord gateway to finish deploying."
          : "Finish Discord setup in your browser, then return here.",
      }),
      "info",
      5000,
    );
  };
  const handleOpenManagedDiscord = async () => {
    if (managedDiscordBusy) {
      return;
    }

    if (!elizaCloudConnected) {
      setState("cloudDashboardView", "billing");
      setTab("settings");
      setActionNotice(
        t("pluginsview.ManagedDiscordRequiresCloud", {
          defaultValue:
            "Connect Eliza Cloud first, then you can use managed Discord OAuth.",
        }),
        "info",
        5000,
      );
      return;
    }

    setManagedDiscordBusy(true);
    try {
      const response = await client.getCloudCompatAgents();
      const agents = Array.isArray(response.data) ? response.data : [];
      const choice = resolveManagedDiscordAgentChoice(agents);

      if (choice.mode === "none" || choice.mode === "bootstrap") {
        const gatewayResponse =
          await client.ensureCloudCompatManagedDiscordAgent();
        const gatewayAgent = gatewayResponse.data.agent;
        const gatewayDeploying =
          await ensureManagedDiscordGatewayProvisioned(gatewayAgent);

        setManagedDiscordAgents([gatewayAgent]);
        setManagedDiscordSelectedAgentId(gatewayAgent.agent_id);
        setManagedDiscordPickerOpen(false);
        setActionNotice(
          t("pluginsview.ManagedDiscordGatewayCreated", {
            defaultValue: gatewayResponse.data.created
              ? "Created a shared Discord gateway agent. Continue in your browser and choose a server you own."
              : "Using your shared Discord gateway agent. Continue in your browser and choose a server you own.",
          }),
          "info",
          5200,
        );
        await startManagedDiscordOauth(gatewayAgent, {
          gatewayDeploying,
        });
        return;
      }

      if (choice.mode === "picker") {
        setManagedDiscordAgents(agents);
        setManagedDiscordSelectedAgentId(choice.selectedAgentId);
        setManagedDiscordPickerOpen(true);
        setActionNotice(
          t("pluginsview.ManagedDiscordChooseTarget", {
            defaultValue:
              "Choose which cloud agent should receive managed Discord for this owned server, then continue.",
          }),
          "info",
          4200,
        );
        return;
      }

      const gatewayDeploying = await ensureManagedDiscordGatewayProvisioned(
        choice.agent,
      );
      await startManagedDiscordOauth(choice.agent, {
        gatewayDeploying,
      });
    } catch (error) {
      openCloudAgentsView();
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("elizaclouddashboard.DiscordSetupFailed", {
              defaultValue: "Failed to start Discord setup.",
            }),
        "error",
        4200,
      );
    } finally {
      setManagedDiscordBusy(false);
    }
  };
  const handleConfirmManagedDiscordAgent = async () => {
    if (managedDiscordBusy || !managedDiscordSelectedAgentId) {
      return;
    }

    const agent = managedDiscordAgents.find(
      (candidate) => candidate.agent_id === managedDiscordSelectedAgentId,
    );
    if (!agent) {
      setActionNotice(
        t("pluginsview.ManagedDiscordChooseTarget", {
          defaultValue:
            "Choose which cloud agent should receive managed Discord for this owned server, then continue.",
        }),
        "error",
        4200,
      );
      return;
    }

    setManagedDiscordBusy(true);
    try {
      const gatewayDeploying =
        await ensureManagedDiscordGatewayProvisioned(agent);
      await startManagedDiscordOauth(agent, {
        gatewayDeploying,
      });
    } catch (error) {
      openCloudAgentsView();
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("elizaclouddashboard.DiscordSetupFailed", {
              defaultValue: "Failed to start Discord setup.",
            }),
        "error",
        4200,
      );
    } finally {
      setManagedDiscordBusy(false);
    }
  };
  const handleOpenCloudOAuthConnector = async () => {
    if (!cloudOAuthConnector || cloudOAuthBusy) {
      return;
    }

    if (!elizaCloudConnected) {
      setState("cloudDashboardView", "billing");
      setTab("settings");
      setActionNotice(
        t("pluginsview.CloudOauthRequiresCloud", {
          defaultValue:
            "Connect Eliza Cloud first, then you can use OAuth for this connector.",
        }),
        "info",
        5000,
      );
      return;
    }

    setCloudOAuthBusy(true);
    try {
      const redirectUrl =
        typeof window !== "undefined" ? window.location.href : undefined;
      const oauthResponse =
        cloudOAuthConnector.platform === "twitter"
          ? await client.initiateCloudTwitterOauth({
              redirectUrl,
              connectionRole: cloudOAuthConnector.connectionRole,
            })
          : await client.initiateCloudOauth(cloudOAuthConnector.platform, {
              redirectUrl,
              connectionRole: cloudOAuthConnector.connectionRole,
            });

      await handleOpenPluginExternalUrl(oauthResponse.authUrl);
      setActionNotice(cloudOAuthConnector.successNotice, "info", 5000);
    } catch (error) {
      setActionNotice(
        error instanceof Error
          ? error.message
          : t("pluginsview.CloudOauthSetupFailed", {
              defaultValue: "Failed to start OAuth setup.",
            }),
        "error",
        4200,
      );
    } finally {
      setCloudOAuthBusy(false);
    }
  };

  const BrandIcon = getBrandIcon(plugin.id);
  const connectorHeaderMedia = (
    <span
      className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-xl)] border p-2.5 ${
        isSelected
          ? "border-accent/30 bg-accent/18 text-txt-strong"
          : "border-border/50 bg-bg-accent/80 text-muted"
      }`}
    >
      {BrandIcon ? (
        <BrandIcon className="h-5 w-5 shrink-0" />
      ) : (
        renderResolvedIcon(plugin, {
          className:
            "h-4 w-4 shrink-0 rounded-[var(--radius-sm)] object-contain",
          emojiClassName: "text-base",
        })
      )}
    </span>
  );
  const connectorHeaderHeading = (
    <div className="min-w-0">
      <span
        data-testid={`connector-header-${plugin.id}`}
        className="flex min-w-0 flex-wrap items-center gap-2"
      >
        <span className="whitespace-normal break-words [overflow-wrap:anywhere] text-sm font-semibold leading-snug text-txt">
          {plugin.name}
        </span>
        {hasParams ? (
          <span className="text-xs-tight font-medium text-muted">
            {setCount}/{totalCount} {t("common.configured")}
          </span>
        ) : (
          <span className="text-xs-tight font-medium text-muted">
            {noConfigurationNeededLabel}
          </span>
        )}
      </span>
      <div className="mt-2">
        <p className="text-sm text-muted">
          {plugin.description || pluginDescriptionFallback}
        </p>
        {plugin.enabled && !plugin.isActive && (
          <span className="mt-1.5 flex flex-wrap items-center gap-2 text-xs-tight text-muted">
            <StatusBadge
              label={inactiveLabel}
              tone={plugin.loadError ? "danger" : "warning"}
            />
          </span>
        )}
      </div>
    </div>
  );
  const statusLabel = allParamsSet ? readyLabel : needsSetupLabel;
  const StatusIcon = allParamsSet ? CheckCircle2 : AlertCircle;
  const connectorHeaderActions = (
    <>
      <span
        role="img"
        aria-label={statusLabel}
        title={statusLabel}
        className={`inline-flex items-center ${
          allParamsSet ? "text-ok" : "text-warn"
        }`}
      >
        <StatusIcon className="h-5 w-5" aria-hidden="true" />
      </span>
      <Switch
        checked={plugin.enabled}
        disabled={toggleDisabled}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        onCheckedChange={(checked) => {
          void handleTogglePlugin(plugin.id, checked);
        }}
        aria-label={`${plugin.enabled ? t("common.off") : t("common.on")} ${
          plugin.name
        }`}
      />
      <Button
        variant="ghost"
        size="icon"
        className={`h-8 w-8 shrink-0 rounded-none border-0 bg-transparent transition-colors hover:bg-transparent ${
          isExpanded ? "text-txt" : "text-muted hover:text-txt"
        }`}
        onClick={(event) => {
          event?.stopPropagation();
          handleConnectorSectionToggle(plugin.id);
        }}
        aria-expanded={isExpanded}
        aria-label={`${isExpanded ? collapseLabel : expandLabel} ${
          plugin.name
        }`}
        title={isExpanded ? collapseLabel : expandLabel}
      >
        <ChevronRight
          className={`h-4 w-4 transition-transform ${
            isExpanded ? "rotate-90" : ""
          }`}
        />
      </Button>
    </>
  );
  const setupPanelPluginId = connectorMode.setupPluginId ?? plugin.id;
  const connectorSetupPanel = setupPanelPluginId ? (
    <ConnectorSetupPanel pluginId={setupPanelPluginId} />
  ) : null;
  const supportsConnectorSetupPanel =
    Boolean(setupPanelPluginId) && hasConnectorSetupPanel(setupPanelPluginId);
  const showPluginConfig =
    hasParams &&
    setupPanelPluginId === plugin.id &&
    !isDiscordManagedMode &&
    !isCloudOAuthMode;

  return (
    <div key={plugin.id} data-testid={`connector-section-${plugin.id}`}>
      <PagePanel.CollapsibleSection
        ref={registerConnectorContentItem(plugin.id)}
        variant="section"
        data-testid={`connector-card-${plugin.id}`}
        expanded={isExpanded}
        expandOnCollapsedSurfaceClick
        className={`border-transparent transition-all ${
          isSelected ? "shadow-[0_18px_40px_rgba(3,5,10,0.16)]" : ""
        }`}
        onExpandedChange={(nextExpanded) =>
          handleConnectorExpandedChange(plugin.id, nextExpanded)
        }
        media={connectorHeaderMedia}
        heading={connectorHeaderHeading}
        headingClassName="w-full text-inherit"
        actions={connectorHeaderActions}
      >
        {connectorMode.modes.length > 1 && (
          <ConnectorModeSelector
            connectorId={plugin.id}
            selectedMode={connectorMode.selectedMode}
            onModeChange={connectorMode.setSelectedMode}
            elizaCloudConnected={elizaCloudConnected}
          />
        )}

        {plugin.id === "discord" &&
          (!elizaCloudConnected ||
            connectorMode.selectedMode === "managed") && (
            <PagePanel.Notice
              tone="default"
              className="mb-4"
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-semibold"
                  onClick={() => {
                    void handleOpenManagedDiscord();
                  }}
                  disabled={managedDiscordBusy}
                >
                  {managedDiscordBusy
                    ? "..."
                    : elizaCloudConnected
                      ? t("pluginsview.UseManagedDiscord", {
                          defaultValue: "Use managed Discord",
                        })
                      : t("pluginsview.OpenElizaCloud", {
                          defaultValue: "Open Eliza Cloud",
                        })}
                </Button>
              }
            >
              {elizaCloudConnected
                ? t("pluginsview.ManagedDiscordGatewayHintConnected", {
                    defaultValue:
                      "Prefer OAuth? Managed Discord uses a shared gateway and only works for servers owned by the linking Discord account.",
                  })
                : t("pluginsview.ManagedDiscordGatewayHint", {
                    defaultValue:
                      "Prefer OAuth? Connect Eliza Cloud to use the shared Discord gateway instead of a local bot token.",
                  })}
              {managedDiscordPickerOpen && managedDiscordAgents.length > 1 ? (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Select
                    value={managedDiscordSelectedAgentId ?? "__none__"}
                    onValueChange={(next: string) =>
                      setManagedDiscordSelectedAgentId(
                        next === "__none__" ? null : next,
                      )
                    }
                  >
                    <SelectTrigger className="h-9 min-w-[14rem] rounded-[var(--radius-lg)] border-border/40 bg-bg/80 text-sm">
                      <SelectValue
                        placeholder={t(
                          "pluginsview.ManagedDiscordSelectAgent",
                          {
                            defaultValue: "Select a cloud agent",
                          },
                        )}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {managedDiscordAgents.map((agent) => (
                        <SelectItem key={agent.agent_id} value={agent.agent_id}>
                          {agent.agent_name || agent.agent_id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="default"
                    size="sm"
                    className="h-9 rounded-[var(--radius-lg)] px-4 text-xs-tight font-semibold"
                    onClick={() => {
                      void handleConfirmManagedDiscordAgent();
                    }}
                    disabled={
                      managedDiscordBusy || !managedDiscordSelectedAgentId
                    }
                  >
                    {managedDiscordBusy
                      ? "..."
                      : t("common.continue", {
                          defaultValue: "Continue",
                        })}
                  </Button>
                </div>
              ) : null}
            </PagePanel.Notice>
          )}

        {cloudOAuthConnector ? (
          <PagePanel.Notice
            tone="default"
            className="mb-4"
            actions={
              <Button
                variant="outline"
                size="sm"
                className="h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-semibold"
                onClick={() => {
                  void handleOpenCloudOAuthConnector();
                }}
                disabled={cloudOAuthBusy}
              >
                {cloudOAuthBusy
                  ? "..."
                  : elizaCloudConnected
                    ? cloudOAuthConnector.buttonLabel
                    : t("pluginsview.OpenElizaCloud", {
                        defaultValue: "Open Eliza Cloud",
                      })}
              </Button>
            }
          >
            {elizaCloudConnected
              ? cloudOAuthConnector.connectedHint
              : cloudOAuthConnector.disconnectedHint}
          </PagePanel.Notice>
        ) : null}

        {showTelegramCloudGatewayNotice ? (
          <PagePanel.Notice
            tone="default"
            className="mb-4"
            actions={
              elizaCloudConnected ? undefined : (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-semibold"
                  onClick={() => {
                    setState("cloudDashboardView", "billing");
                    setTab("settings");
                  }}
                >
                  {t("pluginsview.OpenElizaCloud", {
                    defaultValue: "Open Eliza Cloud",
                  })}
                </Button>
              )
            }
          >
            {elizaCloudConnected
              ? t("pluginsview.TelegramCloudGatewayHint", {
                  defaultValue:
                    "Telegram does not support bot-install OAuth for bidirectional chats. Use a BotFather token here; Eliza Cloud can host the webhook gateway and route updates to this app.",
                })
              : t("pluginsview.TelegramCloudGatewayHintDisconnected", {
                  defaultValue:
                    "Telegram does not support bot-install OAuth for bidirectional chats. Connect Eliza Cloud to host the webhook gateway, then use a BotFather token here.",
                })}
          </PagePanel.Notice>
        ) : null}

        {pluginLinks.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {pluginLinks.map((link) => (
              <Button
                key={`${plugin.id}:${link.key}`}
                variant="outline"
                size="sm"
                className="h-8 rounded-[var(--radius-lg)] border-border/40 bg-card/40 px-3 text-xs-tight font-semibold text-muted transition-all hover:border-accent hover:bg-accent/5 hover:text-txt"
                onClick={() => {
                  void handleOpenPluginExternalUrl(link.url);
                }}
                title={`${pluginResourceLinkLabel(t, link.key)}: ${link.url}`}
              >
                {pluginResourceLinkLabel(t, link.key)}
              </Button>
            ))}
          </div>
        )}

        {isStoreInstallMissing && !plugin.loadError && (
          <PagePanel.Notice
            tone="warning"
            className="mb-4"
            actions={
              <Button
                variant="default"
                size="sm"
                className="h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-bold"
                disabled={installingPlugins.has(plugin.id)}
                onClick={() =>
                  void handleInstallPlugin(plugin.id, plugin.npmName ?? "")
                }
              >
                {installingPlugins.has(plugin.id)
                  ? installProgressLabel(
                      installProgress.get(plugin.npmName ?? "")?.message,
                    )
                  : installPluginLabel}
              </Button>
            }
          >
            {connectorInstallPrompt}
          </PagePanel.Notice>
        )}

        {showPluginConfig ? (
          <div className="space-y-4">
            {plugin.id === "telegram" ? (
              <TelegramPluginConfig
                plugin={plugin}
                pluginConfigs={pluginConfigs}
                onParamChange={handleParamChange}
              />
            ) : (
              <PluginConfigForm
                plugin={plugin}
                pluginConfigs={pluginConfigs}
                onParamChange={handleParamChange}
              />
            )}
            {connectorSetupPanel}
          </div>
        ) : supportsConnectorSetupPanel ? (
          connectorSetupPanel
        ) : (
          <div className="text-sm text-muted">{noConfigurationNeededLabel}</div>
        )}

        {plugin.validationErrors && plugin.validationErrors.length > 0 && (
          <PagePanel.Notice tone="danger" className="mt-3 text-xs">
            {plugin.validationErrors.map((error) => (
              <div key={`${plugin.id}:${error.field}:${error.message}`}>
                <span className="font-medium text-warn">{error.field}</span>:{" "}
                {error.message}
              </div>
            ))}
          </PagePanel.Notice>
        )}

        {plugin.validationWarnings && plugin.validationWarnings.length > 0 && (
          <PagePanel.Notice tone="default" className="mt-3 text-xs">
            {plugin.validationWarnings.map((warning) => (
              <div key={`${plugin.id}:${warning.field}:${warning.message}`}>
                {warning.message}
              </div>
            ))}
          </PagePanel.Notice>
        )}

        {plugin.version ? (
          <div className="mt-4">
            <PagePanel.Meta compact tone="strong" className="font-mono">
              v{plugin.version}
            </PagePanel.Meta>
          </div>
        ) : null}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {plugin.isActive && (
            <Button
              variant={
                testResult?.success
                  ? "default"
                  : testResult?.error
                    ? "destructive"
                    : "outline"
              }
              size="sm"
              className={`h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-bold transition-all ${
                testResult?.loading
                  ? "cursor-wait opacity-70"
                  : testResult?.success
                    ? "border-ok bg-ok text-ok-fg hover:bg-ok/90"
                    : testResult?.error
                      ? "border-danger bg-danger text-danger-fg hover:bg-danger/90"
                      : "border-border/40 bg-card/40 hover:border-accent/40"
              }`}
              disabled={testResult?.loading}
              onClick={() => void handleTestConnection(plugin.id)}
            >
              {formatTestConnectionLabel(testResult)}
            </Button>
          )}
          {hasParams && (
            <>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-semibold text-muted hover:text-txt"
                onClick={() => handleConfigReset(plugin.id)}
              >
                {t("common.reset")}
              </Button>
              <Button
                variant={saveSuccess ? "default" : "secondary"}
                size="sm"
                className={`h-8 rounded-[var(--radius-lg)] px-4 text-xs-tight font-bold transition-all ${
                  saveSuccess
                    ? "bg-ok text-ok-fg hover:bg-ok/90"
                    : "bg-accent text-accent-fg hover:bg-accent/90"
                }`}
                onClick={() => void handleConfigSave(plugin.id)}
                disabled={isSaving}
              >
                {formatSaveSettingsLabel(isSaving, saveSuccess)}
              </Button>
            </>
          )}
        </div>
      </PagePanel.CollapsibleSection>
    </div>
  );
}

export function ConnectorPluginGroups(props: ConnectorPluginGroupsProps) {
  const groups = groupVisiblePlugins(props.visiblePlugins);

  if (groups.length === 1) {
    return groups[0].plugins.map((plugin) => (
      <ConnectorPluginCard key={plugin.id} {...props} plugin={plugin} />
    ));
  }

  return groups.map((group) => (
    <div
      key={group.id}
      className="relative rounded-[var(--radius-lg)] border border-border/30 px-2 pb-2 pt-5"
    >
      <span className="absolute -top-2.5 left-3 bg-bg px-2 text-2xs font-semibold uppercase tracking-wider text-muted">
        {group.label}
      </span>
      <div className="space-y-4">
        {group.plugins.map((plugin) => (
          <ConnectorPluginCard key={plugin.id} {...props} plugin={plugin} />
        ))}
      </div>
    </div>
  ));
}
