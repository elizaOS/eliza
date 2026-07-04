/**
 * Registry of connector setup-mode declarations, keyed by connector id (#12094).
 *
 * A connector's setup UI (`ConnectorModeSelector`) renders its mode selector
 * generically from these declarations rather than a per-connector `switch`, so
 * a connector plugin whose id appears nowhere in this package still gets a
 * working mode selector by calling {@link registerConnectorModes} — the same
 * pattern `registerConnectorSetupPanel` uses for panels. Built-in connectors
 * are seeded at module load below; `ConnectorModeSelector.helpers.ts` reads
 * back through {@link getDeclaredConnectorModes}.
 */

import {
  type ConnectorManagementMode,
  normalizeConnectorCatalogId,
} from "./connector-account-options";

/**
 * Declarative description of a single connector setup mode: the metadata a
 * connector plugin declares (in its registry entry / manifest) so the setup UI
 * can render its mode selector without hardcoding the connector.
 */
/**
 * The kind of cloud-gateway setup affordance a connector mode declares. Read by
 * the connector page to render the correct gateway surface without hardcoding
 * connector ids. See {@link ConnectorModeDeclaration.cloudGatewaySetup}.
 */
export type ConnectorCloudGatewaySetup =
  | "managed-agent-picker"
  | "webhook-notice";

/**
 * The hosted-gateway provisioning flow backing a `"managed-agent-picker"` mode.
 * Each value maps to a bespoke provisioning handler + copy in the connector
 * page. Currently only the managed-Discord flow exists.
 */
export type ConnectorManagedGatewayProvider = "eliza-cloud-discord";

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
   * UI affordance a cloud-managed gateway mode declares so the connector page
   * renders the right gateway setup surface generically, instead of matching
   * `plugin.id` + mode id string literals (#12090 item 28).
   *
   * - `"managed-agent-picker"`: this mode is backed by a hosted Eliza Cloud
   *   gateway the user provisions/picks an agent for (e.g. managed Discord).
   *   Treated as cloud-backed for the connector's Ready state.
   * - `"webhook-notice"`: this mode still needs local credentials but Eliza
   *   Cloud can host its inbound webhook, so the page shows a gateway hint
   *   (e.g. Telegram cloud gateway) without picking a hosted agent.
   *
   * Omitted for modes that need no cloud-gateway affordance. The picker/notice
   * bodies themselves stay owned by the connector (their copy + handlers), but
   * *which* affordance to show is resolved from this declared capability.
   */
  cloudGatewaySetup?: ConnectorCloudGatewaySetup;
  /**
   * For a `"managed-agent-picker"` mode, the id of the hosted-gateway
   * provisioning flow that backs it. The connector page renders the matching
   * provider-specific picker (its bespoke provisioning handler + copy) keyed on
   * this declared value instead of the connector's plugin id (#12090 item 28).
   * Only `"eliza-cloud-discord"` exists today (managed Discord); a connector
   * declaring `managed-agent-picker` with an unknown/undeclared provider gets
   * no picker rather than being misrouted through the Discord flow.
   */
  cloudGatewayProvider?: ConnectorManagedGatewayProvider;
  /**
   * Optional owner-declared footnote rendered beneath this mode's env-config
   * form (e.g. Discord's "Application ID is optional, auto-resolved from the
   * bot token" hint). Declared here so the settings config form does not match
   * `plugin.id === "discord"` to decide whether to show it (#12090 item 28).
   * `configFormHintKey` is the i18n key; `configFormHint` is the default copy.
   */
  configFormHintKey?: string;
  configFormHint?: string;
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

/**
 * Resolves the cloud-gateway setup affordance a connector's *selected* mode
 * declares, or `null` when the mode declares none (or is unknown). Lets the
 * connector page decide which gateway surface to render from owner-declared
 * metadata instead of matching `plugin.id` + mode id string literals
 * (#12090 item 28).
 */
export function getConnectorModeCloudGatewaySetup(
  connectorId: string,
  modeId: string | null | undefined,
): ConnectorCloudGatewaySetup | null {
  if (!modeId) return null;
  return (
    getDeclaredConnectorModes(connectorId).find((mode) => mode.id === modeId)
      ?.cloudGatewaySetup ?? null
  );
}

/**
 * Whether a connector declares *any* mode with the given cloud-gateway setup
 * affordance, regardless of which mode is currently selected. Lets the
 * connector page show a gateway hint (e.g. "connect Eliza Cloud for webhook
 * hosting") for connectors that support that gateway kind, without hardcoding
 * the connector id (#12090 item 28).
 */
export function connectorDeclaresCloudGatewaySetup(
  connectorId: string,
  setup: ConnectorCloudGatewaySetup,
): boolean {
  return getDeclaredConnectorModes(connectorId).some(
    (mode) => mode.cloudGatewaySetup === setup,
  );
}

/**
 * The managed-gateway provisioning provider a connector declares for its
 * `"managed-agent-picker"` mode, or `null` when the connector declares no such
 * mode or leaves the provider undeclared. The connector page renders the
 * matching provider-specific picker keyed on this value, so a connector cannot
 * be misrouted through a provider flow it did not declare (#12090 item 28).
 */
export function getConnectorManagedGatewayProvider(
  connectorId: string,
): ConnectorManagedGatewayProvider | null {
  return (
    getDeclaredConnectorModes(connectorId).find(
      (mode) => mode.cloudGatewaySetup === "managed-agent-picker",
    )?.cloudGatewayProvider ?? null
  );
}

/**
 * A connector-declared config-form footnote: its default copy plus an optional
 * i18n key. `key` is omitted when the declaration provides no translation key,
 * so the consumer renders `fallback` directly instead of calling `t("")`.
 */
export interface ConnectorConfigFormHint {
  key?: string;
  fallback: string;
}

/**
 * Resolves the config-form footnote a connector's *selected* mode declares, or
 * `null` when that mode declares none. Lets the settings config form render the
 * hint generically instead of matching `plugin.id` (#12090 item 28).
 *
 * When `modeId` is null/undefined (single-mode connectors have no mode
 * selector) the connector's first hint-bearing mode is used. When `modeId` is
 * given but that specific mode declares no hint, `null` is returned — the hint
 * is scoped to the modes that declare it, so it does not leak onto an unrelated
 * selected mode.
 */
export function getConnectorModeConfigFormHint(
  connectorId: string,
  modeId: string | null | undefined,
): ConnectorConfigFormHint | null {
  const modes = getDeclaredConnectorModes(connectorId);
  const declaration = modeId
    ? modes.find((mode) => mode.id === modeId)
    : modes.find((mode) => mode.configFormHint !== undefined);
  if (!declaration?.configFormHint) return null;
  return declaration.configFormHintKey
    ? {
        key: declaration.configFormHintKey,
        fallback: declaration.configFormHint,
      }
    : { fallback: declaration.configFormHint };
}

// ---------------------------------------------------------------------------
// Built-in connector mode declarations.
//
// Declaration order is significant — it is the exact order modes are presented
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
    cloudGatewaySetup: "managed-agent-picker",
    cloudGatewayProvider: "eliza-cloud-discord",
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
    configFormHintKey: "settings.sections.connectors.discordAppIdHint",
    configFormHint:
      "Application ID is optional; it is auto-resolved from the bot token when possible.",
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
    cloudGatewaySetup: "webhook-notice",
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
