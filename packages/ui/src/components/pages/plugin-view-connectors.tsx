/**
 * Connector cards for the Plugins view: renders each connector plugin (Discord,
 * Telegram, Signal, cloud OAuth connections, …) as an expandable card that
 * co-renders its config form and its setup/account-management panel — including
 * the case where a mode delegates its setup panel to a *different* plugin id.
 * `ConnectorPluginGroups` groups the visible connectors and lays them out flat
 * (no card chrome; group labels + whitespace do the separation).
 */

import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ChevronRight,
  UserRound,
} from "lucide-react";
import { type ReactNode, type RefCallback, useState } from "react";
import { useAgentElement } from "../../agent-surface";
import {
  type CloudCompatAgent,
  type CloudOAuthConnectionRole,
  client,
  type PluginInfo,
} from "../../api";
import { useAppSelectorShallow } from "../../state";
import { getProvenanceFlags, getProvenanceTitle } from "../apps/provenance";
import { PagePanel } from "../composites/page-panel";
import { ConnectorModeSelector } from "../connectors/ConnectorModeSelector";
import { useConnectorMode } from "../connectors/ConnectorModeSelector.hooks";
import { ConnectorSetupPanel } from "../connectors/ConnectorSetupPanel";
import { hasConnectorSetupPanel } from "../connectors/ConnectorSetupPanel.helpers";
import {
  connectorDeclaresCloudGatewaySetup,
  getConnectorManagedGatewayProvider,
  getConnectorModeCloudGatewaySetup,
} from "../connectors/connector-mode-registry";
import { getBrandIcon } from "../conversations/brand-icons";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { StatusBadge } from "../ui/status-badge";
import { Switch } from "../ui/switch";
import {
  buildManagedDiscordSettingsReturnUrl,
  resolveManagedDiscordAgentChoice,
} from "./cloud-dashboard-utils";
import { PluginConfigForm } from "./PluginConfigForm";
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

export function shouldRenderConnectorPluginConfig({
  hasParams,
  isCloudOAuthMode,
  isManagedAgentGatewayMode,
}: {
  hasParams: boolean;
  isCloudOAuthMode: boolean;
  isManagedAgentGatewayMode: boolean;
}): boolean {
  return hasParams && !isManagedAgentGatewayMode && !isCloudOAuthMode;
}

type CloudOAuthConnectorCopy = {
  platform: "slack" | "twitter" | "google";
  /**
   * Roles the user can connect for this platform. A single-entry array
   * renders one button (legacy behavior); a two-entry array (e.g.
   * `["agent", "owner"]`) renders one button per role so the user can
   * connect the agent's own account AND their own platform account
   * independently. The cloud OAuth callback honors `connectionRole` and
   * stores each grant under the right role in `platform_credentials`.
   */
  connectionRoles: CloudOAuthConnectionRole[];
  buttonLabel: string;
  connectedHint: string;
  disconnectedHint: string;
  successNotice: string;
  /**
   * Which cloud OAuth-initiation client method this connector uses, declared on
   * the connector copy instead of matching `platform === "twitter"` at the call
   * site (#12090 item 28):
   * - `"twitter-endpoint"`: the dedicated `initiateCloudTwitterOauth` method.
   * - `"generic"` (default): `initiateCloudOauth(platform, ...)`.
   */
  oauthInitiation?: "twitter-endpoint" | "generic";
};

const ROLE_BUTTON_SUFFIX: Record<CloudOAuthConnectionRole, string> = {
  agent: "(agent)",
  owner: "(your account)",
};

function buildRoleButtonLabel(
  baseLabel: string,
  role: CloudOAuthConnectionRole,
  showRoleSuffix: boolean,
): string {
  if (!showRoleSuffix) {
    return baseLabel;
  }
  return `${baseLabel} ${ROLE_BUTTON_SUFFIX[role]}`;
}

function cloudOAuthRoleTitle(
  platform: string,
  role: CloudOAuthConnectionRole,
): string {
  return role === "agent"
    ? `Connect the agent's ${platform} identity.`
    : `Connect your own ${platform} identity.`;
}

const CLOUD_OAUTH_CONNECTORS: Record<string, CloudOAuthConnectorCopy> = {
  slack: {
    platform: "slack",
    connectionRoles: ["agent", "owner"],
    buttonLabel: "Use Slack OAuth",
    connectedHint: "OAuth ready. Choose agent bot or owner account.",
    disconnectedHint:
      "Connect Eliza Cloud first to use Slack OAuth instead of local Socket Mode tokens.",
    successNotice: "Finish Slack OAuth in your browser, then return here.",
  },
  twitter: {
    platform: "twitter",
    connectionRoles: ["agent", "owner"],
    buttonLabel: "Use X/Twitter OAuth",
    connectedHint: "OAuth ready. Choose agent account or owner account.",
    disconnectedHint:
      "Connect Eliza Cloud first to use X/Twitter OAuth instead of local developer tokens.",
    successNotice: "Finish X/Twitter OAuth in your browser, then return here.",
    oauthInitiation: "twitter-endpoint",
  },
  google: {
    platform: "google",
    connectionRoles: ["agent", "owner"],
    buttonLabel: "Use Google OAuth",
    connectedHint: "OAuth ready. Choose agent workspace or owner account.",
    disconnectedHint:
      "Connect Eliza Cloud first to use Google OAuth instead of local OAuth2 credentials.",
    successNotice: "Finish Google OAuth in your browser, then return here.",
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

function ConnectorOAuthRoleButton({
  pluginId,
  role,
  label,
  title,
  busy,
  icon,
  onConnect,
}: {
  pluginId: string;
  role: CloudOAuthConnectionRole;
  label: string;
  title: string;
  busy: boolean;
  icon: ReactNode;
  onConnect: (role: CloudOAuthConnectionRole) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `connector-${pluginId}-oauth-${role}`,
    role: "button",
    label,
    group: "connector",
    description: title,
    onActivate: () => onConnect(role),
  });
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
      onClick={() => {
        void onConnect(role);
      }}
      disabled={busy}
      title={title}
      {...agentProps}
    >
      {icon}
      {label}
    </Button>
  );
}

function ConnectorResourceLink({
  pluginId,
  linkKey,
  url,
  label,
  title,
  onOpen,
}: {
  pluginId: string;
  linkKey: string;
  url: string;
  label: string;
  title: string;
  onOpen: (url: string) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `connector-${pluginId}-link-${linkKey}`,
    role: "link",
    label: `${label} (${pluginId})`,
    group: "connector",
    description: title,
    onActivate: () => onOpen(url),
  });
  return (
    <Button
      ref={ref}
      variant="outline"
      size="sm"
      className="h-8 rounded-sm border-border/40 bg-card/40 px-3 text-xs-tight font-semibold text-muted transition-all hover:border-accent hover:bg-accent/5 hover:text-txt"
      onClick={() => {
        void onOpen(url);
      }}
      title={title}
      {...agentProps}
    >
      {label}
    </Button>
  );
}

function connectorProvenanceBadges(plugin: PluginInfo): Array<{
  key: string;
  label: string;
  tone?: "warning" | "success";
  title?: string;
}> {
  const flags = getProvenanceFlags(plugin);
  const title = getProvenanceTitle(flags, "package");
  const badges: Array<{
    key: string;
    label: string;
    tone?: "warning" | "success";
    title?: string;
  }> = [];

  if (flags.isThirdParty) {
    badges.push({ key: "origin", label: "Third party", title });
  } else if (flags.isBuiltIn) {
    badges.push({ key: "origin", label: "Built in", title });
  }

  if (flags.isCommunity) {
    badges.push({ key: "support", label: "Community", tone: "warning", title });
  } else if (flags.isFirstParty) {
    badges.push({
      key: "support",
      label: "First party",
      tone: "success",
      title,
    });
  }

  return badges;
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
  const { elizaCloudConnected, setActionNotice, setState, setTab } =
    useAppSelectorShallow((s) => ({
      elizaCloudConnected: s.elizaCloudConnected,
      setActionNotice: s.setActionNotice,
      setState: s.setState,
      setTab: s.setTab,
    }));
  const connectorMode = useConnectorMode(plugin.id, { elizaCloudConnected });
  const [managedDiscordBusy, setManagedDiscordBusy] = useState(false);
  // Keyed by role so the "agent" and "your account" buttons can each show
  // their own loading state — clicking one no longer disables the other.
  const [cloudOAuthBusy, setCloudOAuthBusy] = useState<
    Partial<Record<CloudOAuthConnectionRole, boolean>>
  >({});
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
  // Which cloud-gateway setup affordance the *selected* mode declares, resolved
  // from owner-declared connector-mode metadata instead of matching plugin id +
  // mode id string literals (#12090 item 28). Connectors declare
  // `cloudGatewaySetup` on their mode in connector-mode-registry.ts.
  const selectedModeCloudGatewaySetup = getConnectorModeCloudGatewaySetup(
    plugin.id,
    connectorMode.selectedMode,
  );
  // A hosted managed-agent gateway (e.g. managed Discord) — treated as
  // cloud-backed for the connector Ready state and rendered with the managed
  // agent picker below.
  const isManagedAgentGatewayMode =
    selectedModeCloudGatewaySetup === "managed-agent-picker";
  // A local-credential mode whose inbound webhook Eliza Cloud can host (e.g.
  // Telegram cloud gateway) — shown as an informational gateway notice.
  const isWebhookGatewayMode =
    selectedModeCloudGatewaySetup === "webhook-notice";
  // Any connector that declares a webhook-notice mode should also surface the
  // "connect Eliza Cloud for webhook hosting" hint before cloud is connected,
  // even if that mode is not the currently selected one — matching the prior
  // behavior that showed the Telegram gateway notice whenever cloud was not
  // connected.
  const showCloudGatewayNotice =
    isWebhookGatewayMode ||
    (!elizaCloudConnected &&
      connectorDeclaresCloudGatewaySetup(plugin.id, "webhook-notice"));
  const cloudBackedConnectorMode =
    elizaCloudConnected && (isCloudOAuthMode || isManagedAgentGatewayMode);
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
  const provenanceBadges = connectorProvenanceBadges(plugin);
  const toggleControl = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-toggle`,
    role: "toggle",
    label: `Toggle ${plugin.name}`,
    group: "connector",
    status: plugin.enabled ? "active" : "inactive",
    description: `Enable or disable the ${plugin.name} connector`,
    onActivate: () => void handleTogglePlugin(plugin.id, !plugin.enabled),
  });
  const expandControl = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-expand`,
    role: "button",
    label: `${isExpanded ? collapseLabel : expandLabel} ${plugin.name}`,
    group: "connector",
    status: isExpanded ? "active" : "inactive",
    description: `Expand or collapse the ${plugin.name} connector section`,
    onActivate: () => handleConnectorSectionToggle(plugin.id),
  });
  const managedDiscordControl = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-managed-discord`,
    role: "button",
    label: `Managed Discord for ${plugin.name}`,
    group: "connector",
    description: "Start managed Discord OAuth via Eliza Cloud",
    onActivate: () => void handleOpenManagedDiscord(),
  });
  const managedDiscordContinueControl = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-managed-discord-continue`,
    role: "button",
    label: "Continue managed Discord setup",
    group: "connector",
    description: "Continue with the selected cloud agent for managed Discord",
    onActivate: () => void handleConfirmManagedDiscordAgent(),
  });
  const telegramOpenCloudControl = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-telegram-open-cloud`,
    role: "button",
    label: "Open Eliza Cloud for Telegram gateway",
    group: "connector",
    description:
      "Open Eliza Cloud billing to enable the Telegram webhook gateway",
    onActivate: () => {
      setState("cloudDashboardView", "billing");
      setTab("settings");
    },
  });
  const installControl = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-install`,
    role: "button",
    label: `Install ${plugin.name}`,
    group: "connector",
    description: `Install the ${plugin.name} connector package`,
    onActivate: () => void handleInstallPlugin(plugin.id, plugin.npmName ?? ""),
  });
  const testControl = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-test`,
    role: "button",
    label: `Test ${plugin.name} connection`,
    group: "connector",
    description: `Run a connection test for ${plugin.name}`,
    onActivate: () => void handleTestConnection(plugin.id),
  });
  const resetControl = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-reset`,
    role: "button",
    label: `Reset ${plugin.name} settings`,
    group: "connector",
    description: `Discard unsaved configuration changes for ${plugin.name}`,
    onActivate: () => handleConfigReset(plugin.id),
  });
  const saveControl = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-save`,
    role: "button",
    label: `Save ${plugin.name} settings`,
    group: "connector",
    description: `Save the configuration for ${plugin.name}`,
    onActivate: () => void handleConfigSave(plugin.id),
  });
  const managedDiscordAgentSelect = useAgentElement<HTMLButtonElement>({
    id: `connector-${plugin.id}-managed-discord-agent`,
    role: "select",
    label: "Managed Discord cloud agent",
    group: "connector",
    description: "Choose which cloud agent receives managed Discord",
    options: managedDiscordAgents.map((agent) => agent.agent_id),
    getValue: () => managedDiscordSelectedAgentId ?? "",
    onFill: (value) =>
      setManagedDiscordSelectedAgentId(value === "" ? null : value),
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
  const handleOpenCloudOAuthConnector = async (
    connectionRole: CloudOAuthConnectionRole,
  ) => {
    if (!cloudOAuthConnector || cloudOAuthBusy[connectionRole]) {
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

    setCloudOAuthBusy((prev) => ({ ...prev, [connectionRole]: true }));
    try {
      const redirectUrl =
        typeof window !== "undefined" ? window.location.href : undefined;
      const oauthResponse =
        cloudOAuthConnector.oauthInitiation === "twitter-endpoint"
          ? await client.initiateCloudTwitterOauth({
              redirectUrl,
              connectionRole,
            })
          : await client.initiateCloudOauth(cloudOAuthConnector.platform, {
              redirectUrl,
              connectionRole,
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
      setCloudOAuthBusy((prev) => ({ ...prev, [connectionRole]: false }));
    }
  };

  const BrandIcon = getBrandIcon(plugin.id);
  const connectorHeaderMedia = (
    <span
      className={`mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border p-2.5 ${
        isSelected
          ? "border-accent/30 bg-accent/18 text-txt-strong"
          : "border-border/50 bg-bg-accent/80 text-muted"
      }`}
    >
      {BrandIcon ? (
        <BrandIcon className="h-5 w-5 shrink-0" />
      ) : (
        renderResolvedIcon(plugin, {
          className: "h-4 w-4 shrink-0 rounded-sm object-contain",
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
        {provenanceBadges.map((badge) => (
          <StatusBadge
            key={`${plugin.id}:${badge.key}`}
            label={badge.label}
            tone={badge.tone}
            title={badge.title}
            className="shrink-0"
          />
        ))}
      </span>
      <div className="mt-2">
        <p
          className="line-clamp-1 text-sm text-muted"
          title={plugin.description || pluginDescriptionFallback}
        >
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
        ref={toggleControl.ref}
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
        {...toggleControl.agentProps}
      />
      <Button
        ref={expandControl.ref}
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
        {...expandControl.agentProps}
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
  const showPluginConfig = shouldRenderConnectorPluginConfig({
    hasParams,
    isCloudOAuthMode,
    isManagedAgentGatewayMode,
  });

  return (
    <div key={plugin.id} data-testid={`connector-section-${plugin.id}`}>
      <PagePanel.CollapsibleSection
        ref={registerConnectorContentItem(plugin.id)}
        variant="section"
        data-testid={`connector-card-${plugin.id}`}
        expanded={isExpanded}
        expandOnCollapsedSurfaceClick
        className="border-transparent transition-all"
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

        {getConnectorManagedGatewayProvider(plugin.id) ===
          "eliza-cloud-discord" &&
          (!elizaCloudConnected || isManagedAgentGatewayMode) && (
            <PagePanel.Notice
              tone="default"
              className="mb-4"
              actions={
                <Button
                  ref={managedDiscordControl.ref}
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
                  onClick={() => {
                    void handleOpenManagedDiscord();
                  }}
                  disabled={managedDiscordBusy}
                  {...managedDiscordControl.agentProps}
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
                    defaultValue: "Managed Discord gateway available.",
                  })
                : t("pluginsview.ManagedDiscordGatewayHint", {
                    defaultValue: "Connect Eliza Cloud for managed Discord.",
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
                    <SelectTrigger
                      ref={managedDiscordAgentSelect.ref}
                      className="h-9 min-w-[14rem] rounded-sm border-border/40 bg-bg/80 text-sm"
                      {...managedDiscordAgentSelect.agentProps}
                    >
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
                    ref={managedDiscordContinueControl.ref}
                    variant="default"
                    size="sm"
                    className="h-9 rounded-sm px-4 text-xs-tight font-semibold"
                    onClick={() => {
                      void handleConfirmManagedDiscordAgent();
                    }}
                    disabled={
                      managedDiscordBusy || !managedDiscordSelectedAgentId
                    }
                    {...managedDiscordContinueControl.agentProps}
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
              <div className="flex flex-wrap items-center gap-2">
                {cloudOAuthConnector.connectionRoles.map((role) => {
                  const roleBusy = cloudOAuthBusy[role] === true;
                  return (
                    <ConnectorOAuthRoleButton
                      key={role}
                      pluginId={plugin.id}
                      role={role}
                      busy={roleBusy}
                      title={cloudOAuthRoleTitle(
                        cloudOAuthConnector.platform,
                        role,
                      )}
                      icon={
                        role === "agent" ? (
                          <Bot className="h-3.5 w-3.5" aria-hidden="true" />
                        ) : (
                          <UserRound
                            className="h-3.5 w-3.5"
                            aria-hidden="true"
                          />
                        )
                      }
                      label={
                        roleBusy
                          ? "..."
                          : elizaCloudConnected
                            ? buildRoleButtonLabel(
                                cloudOAuthConnector.buttonLabel,
                                role,
                                cloudOAuthConnector.connectionRoles.length > 1,
                              )
                            : t("pluginsview.OpenElizaCloud", {
                                defaultValue: "Open Eliza Cloud",
                              })
                      }
                      onConnect={handleOpenCloudOAuthConnector}
                    />
                  );
                })}
              </div>
            }
          >
            {elizaCloudConnected
              ? cloudOAuthConnector.connectedHint
              : cloudOAuthConnector.disconnectedHint}
          </PagePanel.Notice>
        ) : null}

        {showCloudGatewayNotice ? (
          <PagePanel.Notice
            tone="default"
            className="mb-4"
            actions={
              elizaCloudConnected ? undefined : (
                <Button
                  ref={telegramOpenCloudControl.ref}
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-sm px-4 text-xs-tight font-semibold"
                  onClick={() => {
                    setState("cloudDashboardView", "billing");
                    setTab("settings");
                  }}
                  {...telegramOpenCloudControl.agentProps}
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
                  defaultValue: "Webhook gateway available.",
                })
              : t("pluginsview.TelegramCloudGatewayHintDisconnected", {
                  defaultValue: "Connect Eliza Cloud for webhook hosting.",
                })}
          </PagePanel.Notice>
        ) : null}

        {pluginLinks.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {pluginLinks.map((link) => (
              <ConnectorResourceLink
                key={`${plugin.id}:${link.key}`}
                pluginId={plugin.id}
                linkKey={link.key}
                url={link.url}
                label={pluginResourceLinkLabel(t, link.key)}
                title={`${pluginResourceLinkLabel(t, link.key)}: ${link.url}`}
                onOpen={handleOpenPluginExternalUrl}
              />
            ))}
          </div>
        )}

        {isStoreInstallMissing && !plugin.loadError && (
          <PagePanel.Notice
            tone="warning"
            className="mb-4"
            actions={
              <Button
                ref={installControl.ref}
                variant="default"
                size="sm"
                className="h-8 rounded-sm px-4 text-xs-tight font-bold"
                disabled={installingPlugins.has(plugin.id)}
                onClick={() =>
                  void handleInstallPlugin(plugin.id, plugin.npmName ?? "")
                }
                {...installControl.agentProps}
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
            <PluginConfigForm
              plugin={plugin}
              pluginConfigs={pluginConfigs}
              onParamChange={handleParamChange}
            />
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
              ref={testControl.ref}
              variant={
                testResult?.success
                  ? "default"
                  : testResult?.error
                    ? "destructive"
                    : "outline"
              }
              size="sm"
              className={`h-8 rounded-sm px-4 text-xs-tight font-bold transition-all ${
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
              {...testControl.agentProps}
            >
              {formatTestConnectionLabel(testResult)}
            </Button>
          )}
          {hasParams && (
            <>
              <Button
                ref={resetControl.ref}
                variant="ghost"
                size="sm"
                className="h-8 rounded-sm px-4 text-xs-tight font-semibold text-muted hover:text-txt"
                onClick={() => handleConfigReset(plugin.id)}
                {...resetControl.agentProps}
              >
                {t("common.reset")}
              </Button>
              <Button
                ref={saveControl.ref}
                variant={saveSuccess ? "default" : "secondary"}
                size="sm"
                className={`h-8 rounded-sm px-4 text-xs-tight font-bold transition-all ${
                  saveSuccess
                    ? "bg-ok text-ok-fg hover:bg-ok/90"
                    : "bg-accent text-accent-fg hover:bg-accent/90"
                }`}
                onClick={() => void handleConfigSave(plugin.id)}
                disabled={isSaving}
                {...saveControl.agentProps}
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
    /* Flat — no card/border. The group label + whitespace do the separation. */
    <div key={group.id} className="pt-2">
      <div className="mb-3 text-2xs font-semibold uppercase tracking-wider text-muted">
        {group.label}
      </div>
      <div className="space-y-4">
        {group.plugins.map((plugin) => (
          <ConnectorPluginCard key={plugin.id} {...props} plugin={plugin} />
        ))}
      </div>
    </div>
  ));
}
