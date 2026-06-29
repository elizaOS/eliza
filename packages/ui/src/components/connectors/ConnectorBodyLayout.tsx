import type { ReactNode } from "react";

export interface ConnectorBodyLayoutProps {
  /**
   * True when the connector's env-var config form should render (the plugin
   * declares parameters and the active mode targets this plugin — see
   * `shouldRenderConnectorConfigForm`).
   */
  showPluginConfig: boolean;
  /** The connector's env-config form together with its save controls. */
  configForm: ReactNode;
  /**
   * The connector's live setup/status panel (e.g. `TelegramBotSetupPanel`),
   * already gated to `null` when the connector has no registered panel
   * (`hasConnectorSetupPanel`). Callers MUST pass `null` when there is no real
   * panel — a non-null element here is always rendered.
   */
  setupPanel: ReactNode;
  /** Shown when there is neither a config form nor a setup panel. */
  fallback: ReactNode;
  /** Container spacing for the config branch. Defaults to `space-y-4`. */
  className?: string;
}

/**
 * The single source of truth for where a connector's live setup/status panel
 * sits relative to its env-config form.
 *
 * A connector that has BOTH (telegram bot-token mode is the canonical case)
 * renders the form AND the panel together: the form sets the token, the panel
 * validates it live and shows the resolved bot identity. Before this component
 * existed, the Settings → Connectors surface and the `/connectors` page each
 * inlined this three-way branch independently and drifted — Settings dropped the
 * companion panel from the `showPluginConfig` branch, silently hiding
 * `TelegramBotSetupPanel` (issue #10281). Routing both surfaces through this one
 * layout makes that divergence structurally impossible.
 */
export function ConnectorBodyLayout({
  showPluginConfig,
  configForm,
  setupPanel,
  fallback,
  className = "space-y-4",
}: ConnectorBodyLayoutProps): ReactNode {
  if (showPluginConfig) {
    return (
      <div className={className}>
        {configForm}
        {setupPanel}
      </div>
    );
  }
  if (setupPanel) {
    return <>{setupPanel}</>;
  }
  return <>{fallback}</>;
}
