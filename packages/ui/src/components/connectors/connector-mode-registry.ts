import {
  type ConnectorManagementMode,
  normalizeConnectorCatalogId,
} from "./connector-account-options";

/**
 * Declarative description of a single connector setup mode.
 *
 * This is the metadata a connector plugin declares (in its registry entry /
 * manifest) so the setup UI can render its mode selector generically. The
 * previous implementation hardcoded one giant `switch (connectorId)` in
 * `ConnectorModeSelector.helpers.ts`; a new or renamed connector plugin fell
 * through to an empty mode list with no setup UI. Declarations now live in this
 * registry — built-ins are seeded below, and any plugin can register its own
 * via {@link registerConnectorModes}, mirroring the sanctioned
 * `registerConnectorSetupPanel` pattern already used for panels.
 */
export interface ConnectorModeDeclaration {
  /** Mode id, unique within a connector. */
  id: string;
  label: string;
  description: string;
  labelKey?: string;
  descriptionKey?: string;
  managementMode?: ConnectorManagementMode;
  /**
   * Plugin id whose `ConnectorSetupPanel` renders this mode's setup surface.
   * When it equals the connector id the generic env-var config form is used.
   */
  setupPluginId: string;
  /** Mode is only offered when Eliza Cloud is connected. */
  cloudOnly?: boolean;
  /**
   * Preference rank when picking the default selected mode (lower wins). Ties
   * are broken by declaration order. Modes without a rank are never chosen as
   * the default unless no ranked mode is available.
   */
  defaultPriority?: number;
}

const registry = new Map<string, readonly ConnectorModeDeclaration[]>();

/**
 * Register the setup modes a connector plugin declares. The connector id is
 * normalized (`@elizaos/plugin-x` / `twitter` → `x`, etc.) before storage, so
 * callers can pass raw plugin ids. Re-registering a connector replaces its
 * declared modes.
 */
export function registerConnectorModes(
  connectorId: string,
  modes: readonly ConnectorModeDeclaration[],
): void {
  registry.set(normalizeConnectorCatalogId(connectorId), modes);
}

/**
 * Returns the modes a connector has declared, or an empty list when the
 * connector is unknown to the registry (it then falls back to its generic
 * credential form, matching the pre-registry behavior for connectors with no
 * declared mode list).
 */
export function getDeclaredConnectorModes(
  connectorId: string,
): readonly ConnectorModeDeclaration[] {
  return registry.get(normalizeConnectorCatalogId(connectorId)) ?? [];
}

// ---------------------------------------------------------------------------
// Built-in connector mode declarations.
//
// These seed the modes that used to be hardcoded in the `getConnectorModes`
// switch. Ordering is significant — it is the exact order modes are presented
// (cloud-only modes are filtered out when Eliza Cloud is not connected, keeping
// their declared position). The plugin-managed mode is injected separately by
// `withPluginManagedMode` from the connector-account catalog, so it is not
// declared here.
// ---------------------------------------------------------------------------

registerConnectorModes("discord", [
  {
    id: "managed",
    label: "OAuth Gateway",
    labelKey: "connectormode.discord.managed.label",
    description:
      "Invite the shared Eliza Cloud Discord gateway, nickname it to your agent, and route messages down to this app.",
    descriptionKey: "connectormode.discord.managed.description",
    managementMode: "cloud-managed",
    setupPluginId: "discord",
    cloudOnly: true,
  },
  {
    id: "local",
    label: "Desktop App",
    labelKey: "connectormode.discord.local.label",
    description: "Connect via local Discord desktop app (IPC)",
    descriptionKey: "connectormode.discord.local.description",
    managementMode: "local-setup",
    setupPluginId: "discordlocal",
  },
  {
    id: "bot",
    label: "Bot Token",
    labelKey: "connectormode.discord.bot.label",
    description:
      "Use your own Discord bot with a token from the Developer Portal",
    descriptionKey: "connectormode.discord.bot.description",
    managementMode: "local-config",
    setupPluginId: "discord",
    defaultPriority: 1,
  },
]);

registerConnectorModes("telegram", [
  {
    id: "cloud-bot",
    label: "Cloud Gateway",
    labelKey: "connectormode.telegram.cloudBot.label",
    description:
      "Telegram bot communication still starts with a BotFather token; Eliza Cloud can host the webhook and route it to this app.",
    descriptionKey: "connectormode.telegram.cloudBot.description",
    managementMode: "cloud-managed",
    setupPluginId: "telegram",
    cloudOnly: true,
  },
  {
    id: "bot",
    label: "Bot Token",
    labelKey: "connectormode.telegram.bot.label",
    description: "Create a bot via @BotFather and paste the token",
    descriptionKey: "connectormode.telegram.bot.description",
    managementMode: "local-config",
    setupPluginId: "telegram",
    defaultPriority: 1,
  },
  {
    id: "account",
    label: "Personal Account",
    labelKey: "connectormode.telegram.account.label",
    description:
      "Use your own Telegram account (requires app credentials from my.telegram.org)",
    descriptionKey: "connectormode.telegram.account.description",
    managementMode: "local-setup",
    setupPluginId: "telegramaccount",
  },
]);

registerConnectorModes("slack", [
  {
    id: "oauth",
    label: "OAuth",
    labelKey: "connectormode.slack.oauth.label",
    description:
      "Connect Slack through Eliza Cloud OAuth for workspace-scoped bidirectional access.",
    descriptionKey: "connectormode.slack.oauth.description",
    managementMode: "cloud-managed",
    setupPluginId: "slack",
    cloudOnly: true,
    defaultPriority: 1,
  },
  {
    id: "socket",
    label: "Socket Mode Tokens",
    labelKey: "connectormode.slack.socket.label",
    description:
      "Use your own Slack app token and bot token for the local connector runtime.",
    descriptionKey: "connectormode.slack.socket.description",
    managementMode: "local-config",
    setupPluginId: "slack",
    defaultPriority: 2,
  },
]);

registerConnectorModes("x", [
  {
    id: "oauth",
    label: "OAuth",
    labelKey: "connectormode.x.oauth.label",
    description:
      "Connect X/Twitter through Eliza Cloud OAuth so the agent can post, read mentions, and handle DMs through cloud-held tokens.",
    descriptionKey: "connectormode.x.oauth.description",
    managementMode: "cloud-managed",
    setupPluginId: "x",
    cloudOnly: true,
    defaultPriority: 1,
  },
  {
    id: "local-oauth",
    label: "Local OAuth2",
    labelKey: "connectormode.x.localOauth.label",
    description:
      "Use @elizaos/plugin-x with TWITTER_AUTH_MODE=oauth, a client ID, and a loopback redirect URI.",
    descriptionKey: "connectormode.x.localOauth.description",
    managementMode: "local-config",
    setupPluginId: "x",
    defaultPriority: 2,
  },
  {
    id: "developer",
    label: "Developer Tokens",
    labelKey: "connectormode.x.developer.label",
    description:
      "Use OAuth 1.0a API keys and access tokens from the X Developer Portal.",
    descriptionKey: "connectormode.x.developer.description",
    managementMode: "local-config",
    setupPluginId: "x",
  },
]);

registerConnectorModes("signal", [
  {
    id: "qr",
    label: "QR Pair",
    labelKey: "connectormode.signal.qr.label",
    description: "Link as a device to your Signal account via QR code",
    descriptionKey: "connectormode.signal.qr.description",
    managementMode: "local-setup",
    setupPluginId: "signal",
  },
]);

registerConnectorModes("whatsapp", [
  {
    id: "qr",
    label: "QR Pair",
    labelKey: "connectormode.whatsapp.qr.label",
    description: "Scan a QR code from your WhatsApp mobile app",
    descriptionKey: "connectormode.whatsapp.qr.description",
    managementMode: "local-setup",
    setupPluginId: "whatsapp",
  },
  {
    id: "business",
    label: "Business Cloud API",
    labelKey: "connectormode.whatsapp.business.label",
    description:
      "Use WhatsApp Business API with access token and phone number ID",
    descriptionKey: "connectormode.whatsapp.business.description",
    managementMode: "local-config",
    setupPluginId: "whatsapp",
  },
]);

registerConnectorModes("imessage", [
  {
    id: "direct",
    label: "Direct (chat.db)",
    labelKey: "connectormode.imessage.direct.label",
    description:
      "Read iMessage database directly on this Mac. Requires Full Disk Access.",
    descriptionKey: "connectormode.imessage.direct.description",
    managementMode: "local-setup",
    setupPluginId: "imessage",
  },
  {
    id: "bluebubbles",
    label: "BlueBubbles",
    labelKey: "connectormode.imessage.bluebubbles.label",
    description:
      "Bridge via BlueBubbles server app. Works locally or over network.",
    descriptionKey: "connectormode.imessage.bluebubbles.description",
    managementMode: "local-config",
    setupPluginId: "bluebubbles",
  },
  {
    id: "blooio",
    label: "Blooio (Cloud)",
    labelKey: "connectormode.imessage.blooio.label",
    description:
      "Cloud-based iMessage/SMS gateway. No Mac needed on the server.",
    descriptionKey: "connectormode.imessage.blooio.description",
    managementMode: "cloud-managed",
    setupPluginId: "blooio",
    cloudOnly: true,
  },
]);
