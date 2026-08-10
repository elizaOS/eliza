/**
 * Dispatcher that renders the correct setup panel for a connector. Resolves the
 * panel from the runtime registry (`connector-setup-panel-registry`) plus the
 * built-in connector panels in this directory, and falls back to the generic
 * account-management panel for plugin-managed connectors.
 */

import type { GoogleWorkspaceMcpProduct } from "@elizaos/shared/contracts";
import { AlertCircle, Loader2, Plus, SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";
import { getBootConfig } from "../../config/boot-config";
import { useConnectorAccounts } from "../../hooks/useConnectorAccounts";
import {
  navigatePreOpenedWindow,
  preOpenWindow,
} from "../../utils/openExternalUrl";
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
  PERSONAL_GOOGLE_MCP_PRODUCTS,
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
  const [accessMode, setAccessMode] = useState<"manage" | "new" | null>(null);
  const [connectInFlight, setConnectInFlight] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const selectedAccount =
    accounts.selectedAccount?.status === "connected"
      ? accounts.selectedAccount
      : (accounts.accounts.find((account) => account.status === "connected") ??
        null);
  const productIds = useMemo(
    () => new Set(PERSONAL_GOOGLE_MCP_PRODUCTS.map((product) => product.id)),
    [],
  );
  const connectedProducts = useMemo(
    () =>
      (selectedAccount?.selectedProducts ?? []).filter(
        (product): product is GoogleWorkspaceMcpProduct =>
          productIds.has(product as GoogleWorkspaceMcpProduct),
      ),
    [productIds, selectedAccount?.selectedProducts],
  );
  const newlySelectedProducts = selectedProducts.filter(
    (product) => !connectedProducts.includes(product),
  );
  const isConnecting =
    connectInFlight ||
    [...accounts.saving].some((key) =>
      key.startsWith(`oauth:${provider}:${connectorId}:`),
    );

  const connect = async (accountId?: string) => {
    if (
      selectedProducts.length === 0 ||
      isConnecting ||
      (accountId && newlySelectedProducts.length === 0)
    )
      return;
    const popup = preOpenWindow("eliza-google-oauth");
    let launched = false;
    setConnectInFlight(true);
    setConnectError(null);
    try {
      const result = await accounts.startOAuth({
        accountId,
        scopes: capabilitiesForPersonalGoogleProducts(selectedProducts),
      });
      if (!result.authUrl) {
        popup?.close();
        setConnectError(
          "Google did not return an authorization URL. Check the connector status and try again.",
        );
        return;
      }
      navigatePreOpenedWindow(popup, result.authUrl);
      launched = true;
    } catch (error) {
      if (!launched) popup?.close();
      // error-policy:J4 OAuth start is a user-triggered UI boundary; expose a
      // stable recovery path instead of leaking an unhandled rejection.
      const detail = error instanceof Error ? error.message : "";
      const managedRegistrationUnavailable =
        /managed Google OAuth client registration|OAuth not configured|missing client ID/i.test(
          detail,
        );
      setConnectError(
        managedRegistrationUnavailable
          ? "Managed Google connection is unavailable in this build. Install an updated build or ask the deployment administrator to configure it."
          : "Google connection could not start. Check the connector status and try again.",
      );
    } finally {
      setConnectInFlight(false);
    }
  };

  const openAccessMode = (mode: "manage" | "new") => {
    setConnectError(null);
    setSelectedProducts(
      mode === "manage"
        ? [...connectedProducts]
        : [...DEFAULT_PERSONAL_GOOGLE_MCP_PRODUCTS],
    );
    setAccessMode(mode);
  };

  const connectionError = connectError ? (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-sm border border-danger/45 bg-danger/5 px-3 py-2.5 text-xs text-danger"
    >
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p className="leading-relaxed">{connectError}</p>
      </div>
    </div>
  ) : null;

  if (accounts.accounts.length > 0) {
    const managingExisting = accessMode === "manage" && selectedAccount;
    return (
      <div className="flex flex-col gap-3">
        {description ? (
          <p className="text-xs text-muted">{description}</p>
        ) : null}
        <ConnectorAccountList
          provider={provider}
          connectorId={connectorId}
          accountRole="OWNER"
          title="Google accounts"
          externalAccounts={accounts}
          showAddAccount={false}
          showPolicyControls={false}
          showSyncControls={false}
          showProductBadges={accessMode !== "manage"}
          compactSingleAccount
        />

        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              accessMode === "manage"
                ? setAccessMode(null)
                : openAccessMode("manage")
            }
            disabled={!selectedAccount || isConnecting}
            className="flex-1"
          >
            <SlidersHorizontal aria-hidden />
            Manage access
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              accessMode === "new" ? setAccessMode(null) : openAccessMode("new")
            }
            disabled={isConnecting}
            className="flex-1"
          >
            <Plus aria-hidden />
            Add another account
          </Button>
        </div>

        {accessMode ? (
          <section className="space-y-3 rounded-sm border border-border/50 bg-bg-accent/35 p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-txt-strong">
                  {managingExisting
                    ? `Add products for ${selectedAccount.label}`
                    : "Connect another Google account"}
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  {managingExisting
                    ? "Products already connected stay selected. Choose any additional products to authorize."
                    : "Choose the products this account can use."}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => setAccessMode(null)}
                disabled={isConnecting}
                aria-label="Close Google access settings"
              >
                <X aria-hidden />
              </Button>
            </div>

            <GoogleMcpProductSelector
              selectedProducts={selectedProducts}
              lockedProducts={managingExisting ? connectedProducts : []}
              onChange={setSelectedProducts}
              disabled={isConnecting}
              idPrefix={
                managingExisting
                  ? "local-google-manage-mcp-product"
                  : "local-google-additional-mcp-product"
              }
            />

            <Button
              type="button"
              onClick={() =>
                void connect(managingExisting ? selectedAccount.id : undefined)
              }
              disabled={
                isConnecting ||
                selectedProducts.length === 0 ||
                Boolean(managingExisting && newlySelectedProducts.length === 0)
              }
              className="w-full"
            >
              {isConnecting ? (
                <>
                  <Loader2 className="animate-spin" />
                  Connecting...
                </>
              ) : managingExisting ? (
                newlySelectedProducts.length > 0 ? (
                  `Add ${newlySelectedProducts.length} ${
                    newlySelectedProducts.length === 1 ? "product" : "products"
                  }`
                ) : (
                  "All selected products are connected"
                )
              ) : (
                "Connect Google account"
              )}
            </Button>
          </section>
        ) : null}
        {connectionError}
      </div>
    );
  }

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
      {connectionError}
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
