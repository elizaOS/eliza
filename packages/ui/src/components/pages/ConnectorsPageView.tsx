/**
 * Connectors page — curated connector view.
 */

import { PluginsView } from "./PluginsView";

export function ConnectorsPageView({
  inModal,
  connectorDesktopPlacement,
}: {
  inModal?: boolean;
  connectorDesktopPlacement?: "left" | "right";
} = {}) {
  return (
    <PluginsView
      mode="social"
      inModal={inModal ?? false}
      connectorDesktopPlacement={connectorDesktopPlacement}
    />
  );
}
