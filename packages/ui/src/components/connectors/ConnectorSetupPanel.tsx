import { getBootConfig } from "../../config/boot-config";
import { BlueBubblesStatusPanel } from "./BlueBubblesStatusPanel";
import { ConnectorAccountList } from "./ConnectorAccountList";
import { ConnectorAccountSetupScope } from "./ConnectorAccountSetupScope";
import {
  connectorSetupRegistry,
  registerConnectorSetupPanel,
  resolveConnectorSetupPanelKey,
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

function WhatsAppSetupPanel() {
  return (
    <ConnectorAccountSetupScope provider="whatsapp">
      {(accountId) => <WhatsAppQrOverlay accountId={accountId ?? undefined} />}
    </ConnectorAccountSetupScope>
  );
}

function SignalSetupPanel() {
  return (
    <ConnectorAccountSetupScope provider="signal">
      {(accountId) => <SignalQrOverlay accountId={accountId ?? undefined} />}
    </ConnectorAccountSetupScope>
  );
}

// Register the first-party connector setup panels once at module load so the
// panel lookup is a single registry read with no hardcoded per-connector-id
// switch. Plugins register their own panels via registerConnectorSetupPanel.
registerConnectorSetupPanel("whatsapp", WhatsAppSetupPanel);
registerConnectorSetupPanel("signal", SignalSetupPanel);
registerConnectorSetupPanel("discordlocal", DiscordLocalConnectorPanel);
registerConnectorSetupPanel("bluebubbles", BlueBubblesStatusPanel);
registerConnectorSetupPanel("imessage", IMessageStatusPanel);
registerConnectorSetupPanel("telegram", TelegramBotSetupPanel);
registerConnectorSetupPanel("telegramaccount", TelegramAccountConnectorPanel);

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
  const accountManagementPanel =
    parseConnectorAccountManagementPanelPluginId(pluginId);
  if (accountManagementPanel) {
    return <ConnectorAccountManagementPanel {...accountManagementPanel} />;
  }

  const normalized = resolveConnectorSetupPanelKey(pluginId);
  const RegisteredPanel = connectorSetupRegistry.get(normalized);
  if (RegisteredPanel) {
    return <RegisteredPanel />;
  }

  if (
    normalized.includes("lifeopsbrowser") ||
    normalized.includes("browserbridg")
  ) {
    const BrowserBridgeSetupPanel = getBootConfig().lifeOpsBrowserSetupPanel;
    return BrowserBridgeSetupPanel ? <BrowserBridgeSetupPanel /> : null;
  }

  return null;
}
