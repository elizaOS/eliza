/**
 * React-free declaration of the connector setup modes shown in the Settings →
 * Connectors mode selector and routed to setup panels. This is the single
 * source of truth for the mode list, i18n copy, cloud-only gating, default
 * selection, and setup-plugin routing of every connector.
 *
 * The declarations live here (in `@elizaos/shared`) rather than in
 * `@elizaos/ui` so plugin packages — which cannot import `@elizaos/ui` — can
 * register their own connector setup modes via
 * {@link registerConnectorSetupDeclaration}. The React setup-panel components
 * are registered separately in `@elizaos/ui`.
 */

/**
 * How a connector mode is provisioned and where its setup surface lives.
 * - `plugin-managed`: managed through the connector plugin's account inventory.
 * - `cloud-managed`: provisioned/hosted by Eliza Cloud (cloud-only mode).
 * - `local-setup`: a dedicated local setup panel (QR pairing, desktop IPC, …).
 * - `local-config`: env-var / credential config form.
 */
export type ConnectorManagementMode =
  | "plugin-managed"
  | "cloud-managed"
  | "local-setup"
  | "local-config";

/** A single selectable mode within a connector's setup declaration. */
export interface ConnectorSetupModeDeclaration {
  /** Stable mode id (unique within a connector), e.g. `bot`, `qr`, `oauth`. */
  id: string;
  /** Provisioning kind, drives which setup surface renders. */
  managementMode: ConnectorManagementMode;
  /** i18n key for the mode label (e.g. `connectormode.discord.bot.label`). */
  labelKey: string;
  /** English fallback used when the i18n key is missing. */
  labelFallback: string;
  /** i18n key for the mode description. */
  descriptionKey: string;
  /** English fallback used when the i18n key is missing. */
  descriptionFallback: string;
  /** When true, the mode only appears while Eliza Cloud is connected. */
  cloudOnly?: boolean;
  /** Plugin id whose setup panel renders for this mode. */
  setupPluginId: string;
  /**
   * When true, this mode renders a dedicated React setup panel
   * (`ConnectorSetupPanel`) keyed on `setupPluginId`, rather than the generic
   * plugin config form. `local-setup` modes always render a panel and need not
   * set this; it exists for `local-config` modes that also ship a dedicated
   * panel (e.g. the Telegram bot-token panel) and for plugins that want a
   * panel without a `local-setup` mode. Lets the UI decide whether a connector
   * has a setup panel from the declarations alone, without evaluating the
   * React panel module (load-order-independent).
   */
  rendersSetupPanel?: boolean;
}

/** A connector's full setup declaration: its modes, aliases, and default. */
export interface ConnectorSetupDeclaration {
  /** Canonical connector id (normalized), e.g. `discord`, `x`, `imessage`. */
  connectorId: string;
  /** Additional ids that resolve to this declaration (e.g. `twitter` → `x`). */
  aliases?: readonly string[];
  /** Ordered list of selectable modes. */
  modes: readonly ConnectorSetupModeDeclaration[];
  /**
   * Mode ids to prefer as the default selection, in priority order. The first
   * that is currently available (after cloud gating) wins.
   */
  preferredDefaultModeIds?: readonly string[];
}

/**
 * Normalizes a connector/plugin id to its canonical catalog id: strips the
 * `@elizaos/plugin-` and `plugin-` prefixes, lowercases, and maps the
 * `twitter` alias onto `x`. Kept in sync with the copy in
 * `@elizaos/ui`'s `connector-account-options.ts`.
 */
export function normalizeConnectorCatalogId(connectorId: string): string {
  const normalized = connectorId
    .trim()
    .toLowerCase()
    .replace(/^@elizaos\/plugin-/, "")
    .replace(/^plugin-/, "");
  return normalized === "twitter" ? "x" : normalized;
}

export const BUILTIN_CONNECTOR_SETUP_DECLARATIONS: readonly ConnectorSetupDeclaration[] =
  [
    {
      connectorId: "discord",
      preferredDefaultModeIds: ["bot"],
      modes: [
        {
          id: "managed",
          managementMode: "cloud-managed",
          cloudOnly: true,
          labelKey: "connectormode.discord.managed.label",
          labelFallback: "OAuth Gateway",
          descriptionKey: "connectormode.discord.managed.description",
          descriptionFallback:
            "Invite the shared Eliza Cloud Discord gateway, nickname it to your agent, and route messages down to this app.",
          setupPluginId: "discord",
        },
        {
          id: "local",
          managementMode: "local-setup",
          labelKey: "connectormode.discord.local.label",
          labelFallback: "Desktop App",
          descriptionKey: "connectormode.discord.local.description",
          descriptionFallback: "Connect via local Discord desktop app (IPC)",
          setupPluginId: "discordlocal",
        },
        {
          id: "bot",
          managementMode: "local-config",
          labelKey: "connectormode.discord.bot.label",
          labelFallback: "Bot Token",
          descriptionKey: "connectormode.discord.bot.description",
          descriptionFallback:
            "Use your own Discord bot with a token from the Developer Portal",
          setupPluginId: "discord",
        },
      ],
    },
    {
      connectorId: "telegram",
      preferredDefaultModeIds: ["bot"],
      modes: [
        {
          id: "cloud-bot",
          managementMode: "cloud-managed",
          cloudOnly: true,
          labelKey: "connectormode.telegram.cloudBot.label",
          labelFallback: "Cloud Gateway",
          descriptionKey: "connectormode.telegram.cloudBot.description",
          descriptionFallback:
            "Telegram bot communication still starts with a BotFather token; Eliza Cloud can host the webhook and route it to this app.",
          setupPluginId: "telegram",
        },
        {
          id: "bot",
          managementMode: "local-config",
          labelKey: "connectormode.telegram.bot.label",
          labelFallback: "Bot Token",
          descriptionKey: "connectormode.telegram.bot.description",
          descriptionFallback:
            "Create a bot via @BotFather and paste the token",
          setupPluginId: "telegram",
          rendersSetupPanel: true,
        },
        {
          id: "account",
          managementMode: "local-setup",
          labelKey: "connectormode.telegram.account.label",
          labelFallback: "Personal Account",
          descriptionKey: "connectormode.telegram.account.description",
          descriptionFallback:
            "Use your own Telegram account (requires app credentials from my.telegram.org)",
          setupPluginId: "telegramaccount",
        },
      ],
    },
    {
      connectorId: "slack",
      preferredDefaultModeIds: ["oauth", "socket"],
      modes: [
        {
          id: "oauth",
          managementMode: "cloud-managed",
          cloudOnly: true,
          labelKey: "connectormode.slack.oauth.label",
          labelFallback: "OAuth",
          descriptionKey: "connectormode.slack.oauth.description",
          descriptionFallback:
            "Connect Slack through Eliza Cloud OAuth for workspace-scoped bidirectional access.",
          setupPluginId: "slack",
        },
        {
          id: "socket",
          managementMode: "local-config",
          labelKey: "connectormode.slack.socket.label",
          labelFallback: "Socket Mode Tokens",
          descriptionKey: "connectormode.slack.socket.description",
          descriptionFallback:
            "Use your own Slack app token and bot token for the local connector runtime.",
          setupPluginId: "slack",
        },
      ],
    },
    {
      connectorId: "x",
      aliases: ["twitter"],
      preferredDefaultModeIds: ["oauth", "local-oauth"],
      modes: [
        {
          id: "oauth",
          managementMode: "cloud-managed",
          cloudOnly: true,
          labelKey: "connectormode.x.oauth.label",
          labelFallback: "OAuth",
          descriptionKey: "connectormode.x.oauth.description",
          descriptionFallback:
            "Connect X/Twitter through Eliza Cloud OAuth so the agent can post, read mentions, and handle DMs through cloud-held tokens.",
          setupPluginId: "x",
        },
        {
          id: "local-oauth",
          managementMode: "local-config",
          labelKey: "connectormode.x.localOauth.label",
          labelFallback: "Local OAuth2",
          descriptionKey: "connectormode.x.localOauth.description",
          descriptionFallback:
            "Use @elizaos/plugin-x with TWITTER_AUTH_MODE=oauth, a client ID, and a loopback redirect URI.",
          setupPluginId: "x",
        },
        {
          id: "developer",
          managementMode: "local-config",
          labelKey: "connectormode.x.developer.label",
          labelFallback: "Developer Tokens",
          descriptionKey: "connectormode.x.developer.description",
          descriptionFallback:
            "Use OAuth 1.0a API keys and access tokens from the X Developer Portal.",
          setupPluginId: "x",
        },
      ],
    },
    {
      connectorId: "signal",
      modes: [
        {
          id: "qr",
          managementMode: "local-setup",
          labelKey: "connectormode.signal.qr.label",
          labelFallback: "QR Pair",
          descriptionKey: "connectormode.signal.qr.description",
          descriptionFallback:
            "Link as a device to your Signal account via QR code",
          setupPluginId: "signal",
        },
      ],
    },
    {
      connectorId: "whatsapp",
      modes: [
        {
          id: "qr",
          managementMode: "local-setup",
          labelKey: "connectormode.whatsapp.qr.label",
          labelFallback: "QR Pair",
          descriptionKey: "connectormode.whatsapp.qr.description",
          descriptionFallback: "Scan a QR code from your WhatsApp mobile app",
          setupPluginId: "whatsapp",
        },
        {
          id: "business",
          managementMode: "local-config",
          labelKey: "connectormode.whatsapp.business.label",
          labelFallback: "Business Cloud API",
          descriptionKey: "connectormode.whatsapp.business.description",
          descriptionFallback:
            "Use WhatsApp Business API with access token and phone number ID",
          setupPluginId: "whatsapp",
        },
      ],
    },
    {
      connectorId: "imessage",
      modes: [
        {
          id: "direct",
          managementMode: "local-setup",
          labelKey: "connectormode.imessage.direct.label",
          labelFallback: "Direct (chat.db)",
          descriptionKey: "connectormode.imessage.direct.description",
          descriptionFallback:
            "Read iMessage database directly on this Mac. Requires Full Disk Access.",
          setupPluginId: "imessage",
        },
        {
          id: "bluebubbles",
          managementMode: "local-config",
          labelKey: "connectormode.imessage.bluebubbles.label",
          labelFallback: "BlueBubbles",
          descriptionKey: "connectormode.imessage.bluebubbles.description",
          descriptionFallback:
            "Bridge via BlueBubbles server app. Works locally or over network.",
          setupPluginId: "bluebubbles",
          rendersSetupPanel: true,
        },
        {
          id: "blooio",
          managementMode: "cloud-managed",
          cloudOnly: true,
          labelKey: "connectormode.imessage.blooio.label",
          labelFallback: "Blooio (Cloud)",
          descriptionKey: "connectormode.imessage.blooio.description",
          descriptionFallback:
            "Cloud-based iMessage/SMS gateway. No Mac needed on the server.",
          setupPluginId: "blooio",
        },
      ],
    },
  ];

const declarationsByConnectorId = new Map<string, ConnectorSetupDeclaration>();

function indexDeclaration(decl: ConnectorSetupDeclaration): void {
  declarationsByConnectorId.set(
    normalizeConnectorCatalogId(decl.connectorId),
    decl,
  );
  for (const alias of decl.aliases ?? []) {
    declarationsByConnectorId.set(normalizeConnectorCatalogId(alias), decl);
  }
}

for (const decl of BUILTIN_CONNECTOR_SETUP_DECLARATIONS) {
  indexDeclaration(decl);
}

/**
 * Registers a connector setup declaration at runtime. Lets plugin packages
 * declare their own connector mode list, copy, and routing without editing the
 * builtin table. Re-registering an id replaces the prior declaration.
 */
export function registerConnectorSetupDeclaration(
  declaration: ConnectorSetupDeclaration,
): void {
  indexDeclaration(declaration);
}

/**
 * Resolves the setup declaration for a connector id (normalizing prefixes and
 * the `twitter` → `x` alias), or `null` when the connector has no declared
 * modes.
 */
export function getConnectorSetupDeclaration(
  connectorId: string,
): ConnectorSetupDeclaration | null {
  return (
    declarationsByConnectorId.get(normalizeConnectorCatalogId(connectorId)) ??
    null
  );
}

/** Lists every registered connector setup declaration (deduped by identity). */
export function listConnectorSetupDeclarations(): ConnectorSetupDeclaration[] {
  return [...new Set(declarationsByConnectorId.values())];
}

/**
 * The set of setup-plugin ids referenced by any declared mode. Used to decide
 * whether a given plugin id has a dedicated setup panel.
 */
export function getDeclaredSetupPluginIds(): Set<string> {
  const ids = new Set<string>();
  for (const decl of listConnectorSetupDeclarations()) {
    for (const mode of decl.modes) {
      ids.add(normalizeConnectorCatalogId(mode.setupPluginId));
    }
  }
  return ids;
}

/**
 * The set of setup-plugin ids whose declared mode renders a dedicated React
 * setup panel: every `local-setup` mode (QR/pairing/desktop IPC), plus any
 * mode that explicitly opts in via `rendersSetupPanel` (e.g. the Telegram
 * bot-token `local-config` mode). `cloud-managed`, `plugin-managed`, and plain
 * `local-config` (generic config form) modes are excluded.
 *
 * The UI uses this to decide whether to render a ConnectorSetupPanel
 * load-order-independently: unlike the React panel registry (populated only
 * once the panel component module is evaluated), this derives from the pure
 * declarations, so first-party connectors resolve correctly even before their
 * panel module has loaded.
 */
export function getSetupPanelPluginIds(): Set<string> {
  const ids = new Set<string>();
  for (const decl of listConnectorSetupDeclarations()) {
    for (const mode of decl.modes) {
      if (mode.rendersSetupPanel || mode.managementMode === "local-setup") {
        ids.add(normalizeConnectorCatalogId(mode.setupPluginId));
      }
    }
  }
  return ids;
}
