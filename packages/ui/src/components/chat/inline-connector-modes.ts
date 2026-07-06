/**
 * Pure model behind the in-chat connector-setup card's auth-mode switch: which
 * setup modes a `[CONFIG:<pluginId>]` card offers (OAuth sign-in vs API-key /
 * token form vs local bridge) and which one is selected by default.
 *
 * Modes come from the same connector-mode registry the Settings connectors
 * page renders (`connector-mode-registry.ts`), so the chat card and the
 * settings surface can never disagree about what a connector supports. Each
 * declared mode is projected onto one of three widget affordances:
 *
 *  - `oauth`  — cloud-managed / OAuth-shaped modes render a "Sign in with X"
 *    button that drives `POST /api/connectors/:provider/oauth/start` and opens
 *    the returned authorization URL.
 *  - `config` — `local-config` modes render the plugin's env-var form (bot
 *    tokens, API keys).
 *  - `local`  — `local-setup` modes (Signal QR/daemon, iMessage chat.db,
 *    Discord desktop IPC) render the env form plus the mode's guidance text.
 *
 * Kept DOM-free so the mode projection unit-tests without React.
 */

import { getDeclaredConnectorModes } from "../connectors/connector-mode-registry";

export type ConnectorWidgetModeKind = "oauth" | "config" | "local";

export interface ConnectorWidgetMode {
  id: string;
  label: string;
  description: string;
  kind: ConnectorWidgetModeKind;
  /**
   * Plugin id owning this mode's dedicated setup surface (e.g. `discordlocal`
   * for Discord's desktop-app IPC pairing). Lets the card offer that mode's
   * one-click sign-in where one exists instead of a dead-end description.
   */
  setupPluginId: string;
  /** Owner-declared footnote for this mode's config form, when present. */
  configFormHint?: string;
}

/**
 * Classify one declared mode into the widget affordance it renders. OAuth is
 * keyed off the declaration (`cloud-managed` management or an `oauth` mode id),
 * not the connector id, so a new OAuth-capable connector gets the sign-in
 * button by declaring it — no widget edit.
 */
function widgetKindForMode(mode: {
  id: string;
  managementMode?: string;
}): ConnectorWidgetModeKind {
  if (mode.managementMode === "cloud-managed" || /oauth/i.test(mode.id)) {
    return "oauth";
  }
  if (mode.managementMode === "local-setup") return "local";
  return "config";
}

/**
 * The modes the chat setup card offers for a plugin, in declared order.
 * Cloud-only modes are dropped when Eliza Cloud is not connected — offering a
 * sign-in that cannot succeed would be a fabricated affordance. Returns `[]`
 * for plugins with no declared modes (the card then renders its plain env
 * form, exactly the pre-mode behavior).
 */
export function connectorWidgetModes(
  pluginId: string,
  options?: { elizaCloudConnected?: boolean },
): ConnectorWidgetMode[] {
  const cloud = options?.elizaCloudConnected ?? false;
  return getDeclaredConnectorModes(pluginId)
    .filter((mode) => cloud || !mode.cloudOnly)
    .map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description,
      kind: widgetKindForMode(mode),
      setupPluginId: mode.setupPluginId,
      ...(mode.configFormHint ? { configFormHint: mode.configFormHint } : {}),
    }));
}

/**
 * Default selected mode: honors the registry's `defaultPriority` (lower wins)
 * among the offered modes, falling back to the first offered mode. Mirrors
 * `getDefaultConnectorModeId` on the settings page minus the plugin-managed
 * account injection (account management is a settings surface, not a chat
 * card).
 */
export function defaultConnectorWidgetModeId(
  pluginId: string,
  modes: readonly ConnectorWidgetMode[],
): string | null {
  const offered = new Set(modes.map((mode) => mode.id));
  const ranked = getDeclaredConnectorModes(pluginId)
    .filter(
      (mode) => mode.defaultPriority !== undefined && offered.has(mode.id),
    )
    .sort((a, b) => (a.defaultPriority ?? 0) - (b.defaultPriority ?? 0))[0];
  return ranked?.id ?? modes[0]?.id ?? null;
}
