/**
 * Dispatcher that renders the correct setup panel for a connector. Resolves the
 * panel from the runtime registry (`connector-setup-panel-registry`) plus the
 * built-in connector panels in this directory, and falls back to the generic
 * account-management panel for plugin-managed connectors.
 */

import { getBootConfig } from "../../config/boot-config";
import { ConnectorAccountSetupScope } from "./ConnectorAccountSetupScope";
import {
  connectorSetupRegistry,
  normalizePluginId,
} from "./ConnectorSetupPanel.helpers";
import {
  getConnectorPluginManagedAccountCreateInput,
  getConnectorPluginManagedAccountOption,
  parseConnectorAccountManagementPanelPluginId,
} from "./connector-account-options";
import { useConnectorChannelMode } from "./connector-channel-mode";
import { resolveConnectorSetupPanelToken } from "./connector-setup-panel-registry";
import { DiscordLocalConnectorPanel } from "./DiscordLocalConnectorPanel";
import { IMessageStatusPanel } from "./IMessageStatusPanel";
import { OwnerAgentConnectorSetupPanel } from "./OwnerAgentConnectorSetupPanel";
import { TelegramAccountConnectorPanel } from "./TelegramAccountConnectorPanel";
import { TelegramBotSetupPanel } from "./TelegramBotSetupPanel";
import { WhatsAppQrOverlay } from "./WhatsAppQrOverlay";

function ConnectorAccountManagementPanel({
  provider,
  connectorId,
}: {
  provider: string;
  connectorId: string;
}) {
  const channelMode = useConnectorChannelMode();
  const option =
    getConnectorPluginManagedAccountOption(connectorId) ??
    getConnectorPluginManagedAccountOption(provider);
  const createInput = option?.supportsOAuth
    ? undefined
    : getConnectorPluginManagedAccountCreateInput(connectorId);

  return (
    <OwnerAgentConnectorSetupPanel
      provider={provider}
      connectorId={connectorId}
      enableOwner={channelMode === "delegate"}
      enableAgent={channelMode === "bot"}
      enableTeam
      description={option?.description}
      onAddAccount={
        createInput ? (role) => ({ ...createInput, role }) : undefined
      }
    />
  );
}

export function ConnectorSetupPanel({
  pluginId,
}: {
  pluginId: string;
  modeId?: string;
}) {
  const normalized = normalizePluginId(pluginId);
  const accountManagementPanel =
    parseConnectorAccountManagementPanelPluginId(pluginId);

  if (accountManagementPanel) {
    return <ConnectorAccountManagementPanel {...accountManagementPanel} />;
  }

  // Check registry first — plugin-registered panels take precedence
  const RegisteredPanel = connectorSetupRegistry.get(normalized);
  if (RegisteredPanel) {
    return <RegisteredPanel />;
  }

  // Fall back to the built-in panels resolved from the setup-panel registry.
  switch (resolveConnectorSetupPanelToken(normalized)) {
    case "lifeops-browser": {
      // The registry only yields this token while the host has supplied the
      // panel (its rule's `available` gate), so the component is present here.
      const BrowserBridgeSetupPanel = getBootConfig().lifeOpsBrowserSetupPanel;
      return BrowserBridgeSetupPanel ? <BrowserBridgeSetupPanel /> : null;
    }
    case "telegram-account":
      return <TelegramAccountConnectorPanel />;
    case "telegram-bot":
      return <TelegramBotSetupPanel />;
    case "whatsapp":
      return (
        <ConnectorAccountSetupScope provider="whatsapp" connectorId={pluginId}>
          {(accountId) => (
            <WhatsAppQrOverlay accountId={accountId ?? undefined} />
          )}
        </ConnectorAccountSetupScope>
      );
    case "discord-local":
      return <DiscordLocalConnectorPanel />;
    case "imessage":
      return <IMessageStatusPanel />;
    default:
      return null;
  }
}
