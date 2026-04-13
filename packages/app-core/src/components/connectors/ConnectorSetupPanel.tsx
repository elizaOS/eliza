import { BlueBubblesStatusPanel } from "./BlueBubblesStatusPanel";
import { DiscordLocalConnectorPanel } from "./DiscordLocalConnectorPanel";
import { IMessageStatusPanel } from "./IMessageStatusPanel";
import { SignalQrOverlay } from "./SignalQrOverlay";
import { TelegramAccountConnectorPanel } from "./TelegramAccountConnectorPanel";
import { TelegramBotSetupPanel } from "./TelegramBotSetupPanel";
import { WhatsAppQrOverlay } from "./WhatsAppQrOverlay";
import { getBootConfig } from "../../config";

function normalizePluginId(pluginId: string): string {
  return pluginId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function hasConnectorSetupPanel(pluginId: string): boolean {
  const normalized = normalizePluginId(pluginId);
  if (normalized.includes("lifeopsbrowser")) {
    return Boolean(getBootConfig().lifeOpsBrowserSetupPanel);
  }
  if (normalized.includes("telegramaccount")) {
    return true;
  }
  if (normalized.includes("plugintelegram")) {
    return true;
  }
  switch (normalized) {
    case "whatsapp":
    case "signal":
    case "discordlocal":
    case "bluebubbles":
    case "imessage":
    case "telegram":
      return true;
    default:
      return false;
  }
}

export function ConnectorSetupPanel({ pluginId }: { pluginId: string }) {
  const normalized = normalizePluginId(pluginId);
  if (normalized.includes("lifeopsbrowser")) {
    const LifeOpsBrowserSetupPanel = getBootConfig().lifeOpsBrowserSetupPanel;
    return LifeOpsBrowserSetupPanel ? <LifeOpsBrowserSetupPanel /> : null;
  }
  if (normalized.includes("telegramaccount")) {
    return <TelegramAccountConnectorPanel />;
  }
  if (normalized.includes("plugintelegram")) {
    return <TelegramBotSetupPanel />;
  }
  switch (normalized) {
    case "whatsapp":
      return <WhatsAppQrOverlay accountId="default" />;
    case "signal":
      return <SignalQrOverlay accountId="default" />;
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
