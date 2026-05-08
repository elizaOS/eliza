import type React from "react";
import { getBootConfig } from "../../config/boot-config";
import { BlueBubblesStatusPanel } from "./BlueBubblesStatusPanel";
import { ConnectorAccountSetupScope } from "./ConnectorAccountSetupScope";
import { DiscordLocalConnectorPanel } from "./DiscordLocalConnectorPanel";
import { IMessageStatusPanel } from "./IMessageStatusPanel";
import { SignalQrOverlay } from "./SignalQrOverlay";
import { TelegramAccountConnectorPanel } from "./TelegramAccountConnectorPanel";
import { TelegramBotSetupPanel } from "./TelegramBotSetupPanel";
import { WhatsAppQrOverlay } from "./WhatsAppQrOverlay";

function normalizePluginId(pluginId: string): string {
  return pluginId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Connector setup panel registry — allows plugins to register their own
// setup panels at runtime without modifying the hardcoded switch statement.
// ---------------------------------------------------------------------------

const connectorSetupRegistry = new Map<string, React.ComponentType>();

/**
 * Register a custom connector setup panel component for a given connector ID.
 * The connectorId is normalized (lowercased, non-alphanumeric stripped) before
 * storage, so callers can pass raw plugin IDs.
 */
export function registerConnectorSetupPanel(
  connectorId: string,
  component: React.ComponentType,
): void {
  connectorSetupRegistry.set(normalizePluginId(connectorId), component);
}

export function hasConnectorSetupPanel(pluginId: string): boolean {
  const normalized = normalizePluginId(pluginId);
  // Check registry first
  if (connectorSetupRegistry.has(normalized)) {
    return true;
  }
  if (
    normalized.includes("lifeopsbrowser") ||
    normalized.includes("browserbridg")
  ) {
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
          {(accountId) => <SignalQrOverlay accountId={accountId ?? undefined} />}
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
