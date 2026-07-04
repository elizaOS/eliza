import { getBootConfig } from "../../config/boot-config";
import { BlueBubblesStatusPanel } from "./BlueBubblesStatusPanel";
import { ConnectorAccountList } from "./ConnectorAccountList";
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
import { resolveConnectorSetupPanelToken } from "./connector-setup-panel-registry";
import { DiscordLocalConnectorPanel } from "./DiscordLocalConnectorPanel";
import { IMessageStatusPanel } from "./IMessageStatusPanel";
import { SignalQrOverlay } from "./SignalQrOverlay";
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
  const option =
    getConnectorPluginManagedAccountOption(connectorId) ??
    getConnectorPluginManagedAccountOption(provider);
  const createInput = option?.supportsOAuth
    ? undefined
    : () => getConnectorPluginManagedAccountCreateInput(connectorId);

  return (
    <ConnectorAccountList
      provider={provider}
      connectorId={connectorId}
      title={option?.title ?? "Plugin-managed accounts"}
      onAddAccount={createInput}
    />
  );
}

export function ConnectorSetupPanel({ pluginId }: { pluginId: string }) {
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
  if (
    normalized.includes("lifeopsbrowser") ||
    normalized.includes("browserbridg")
  ) {
    const BrowserBridgeSetupPanel = getBootConfig().lifeOpsBrowserSetupPanel;
    return BrowserBridgeSetupPanel ? <BrowserBridgeSetupPanel /> : null;
  }
  switch (resolveConnectorSetupPanelToken(normalized)) {
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
    case "signal":
      return (
        <ConnectorAccountSetupScope provider="signal" connectorId={pluginId}>
          {(accountId) => (
            <SignalQrOverlay accountId={accountId ?? undefined} />
          )}
        </ConnectorAccountSetupScope>
      );
    case "discord-local":
      return <DiscordLocalConnectorPanel />;
    case "bluebubbles":
      return <BlueBubblesStatusPanel />;
    case "imessage":
      return <IMessageStatusPanel />;
    default:
      return null;
  }
}
