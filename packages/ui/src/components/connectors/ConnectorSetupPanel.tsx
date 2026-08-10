/**
 * Dispatcher that renders the correct setup panel for a connector. Resolves the
 * panel from the runtime registry (`connector-setup-panel-registry`) plus the
 * built-in connector panels in this directory, and falls back to the generic
 * account-management panel for plugin-managed connectors.
 */

import type { GoogleWorkspaceMcpProduct } from "@elizaos/shared/contracts";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { getBootConfig } from "../../config/boot-config";
import { useConnectorAccounts } from "../../hooks/useConnectorAccounts";
import { Button } from "../ui/button";
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
import { useConnectorChannelMode } from "./connector-channel-mode";
import { resolveConnectorSetupPanelToken } from "./connector-setup-panel-registry";
import { DiscordLocalConnectorPanel } from "./DiscordLocalConnectorPanel";
import { GoogleMcpProductSelector } from "./GoogleMcpProductSelector";
import {
  capabilitiesForPersonalGoogleProducts,
  DEFAULT_PERSONAL_GOOGLE_MCP_PRODUCTS,
} from "./google-mcp-products";
import { IMessageStatusPanel } from "./IMessageStatusPanel";
import { OwnerAgentConnectorSetupPanel } from "./OwnerAgentConnectorSetupPanel";
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
  const channelMode = useConnectorChannelMode();
  const option =
    getConnectorPluginManagedAccountOption(connectorId) ??
    getConnectorPluginManagedAccountOption(provider);
  const createInput = option?.supportsOAuth
    ? undefined
    : getConnectorPluginManagedAccountCreateInput(connectorId);

  if (provider === "google") {
    return (
      <PersonalGoogleConnectorSetupPanel
        provider={provider}
        connectorId={connectorId}
        description={option?.description}
      />
    );
  }

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

function PersonalGoogleConnectorSetupPanel({
  provider,
  connectorId,
  description,
}: {
  provider: string;
  connectorId: string;
  description?: string;
}) {
  const accounts = useConnectorAccounts(provider, connectorId);
  const [selectedProducts, setSelectedProducts] = useState<
    GoogleWorkspaceMcpProduct[]
  >([...DEFAULT_PERSONAL_GOOGLE_MCP_PRODUCTS]);
  const isConnecting = accounts.saving.has(
    `oauth:${provider}:${connectorId}:new`,
  );

  const connect = async () => {
    if (selectedProducts.length === 0 || isConnecting) return;
    const result = await accounts.startOAuth({
      scopes: capabilitiesForPersonalGoogleProducts(selectedProducts),
    });
    if (result.authUrl && typeof window !== "undefined") {
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {description ? <p className="text-xs text-muted">{description}</p> : null}
      <p className="text-xs text-muted">
        Connect a personal Google account once. This agent calls the selected
        official Google Workspace MCP products with vault-backed OAuth. Gmail
        can create drafts, but cannot send email.
      </p>
      <GoogleMcpProductSelector
        selectedProducts={selectedProducts}
        onChange={setSelectedProducts}
        disabled={isConnecting}
        idPrefix="local-google-mcp-product"
      />
      <Button
        type="button"
        onClick={() => void connect()}
        disabled={isConnecting || selectedProducts.length === 0}
        className="w-full"
      >
        {isConnecting ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Connecting...
          </>
        ) : (
          "Connect Google account"
        )}
      </Button>
      <ConnectorAccountList
        provider={provider}
        connectorId={connectorId}
        accountRole="OWNER"
        title="Personal Google accounts"
        externalAccounts={accounts}
        showAddAccount={false}
        showPolicyControls={false}
      />
    </div>
  );
}

export function ConnectorSetupPanel({
  pluginId,
  modeId,
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
      return <BlueBubblesStatusPanel modeId={modeId} />;
    case "imessage":
      return <IMessageStatusPanel />;
    default:
      return null;
  }
}
