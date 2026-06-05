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

  // Fall back to hardcoded components
  if (
    normalized.includes("lifeopsbrowser") ||
    normalized.includes("browserbridg")
  ) {
    const BrowserBridgeSetupPanel = getBootConfig().lifeOpsBrowserSetupPanel;
    return BrowserBridgeSetupPanel ? <BrowserBridgeSetupPanel /> : null;
  }
  if (normalized.includes("telegramaccount")) {
    return <TelegramAccountConnectorPanel />;
  }
  if (normalized.includes("plugintelegram")) {
    return <TelegramBotSetupPanel />;
  }
  switch (normalized) {
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
    case "discordlocal":
      return <DiscordLocalConnectorPanel />;
    case "bluebubbles":
      return <BlueBubblesStatusPanel />;
    case "imessage":
      return <IMessageStatusPanel />;
    case "telegram":
      return <TelegramBotSetupPanel />;
    default:
      return null;
  }
}
