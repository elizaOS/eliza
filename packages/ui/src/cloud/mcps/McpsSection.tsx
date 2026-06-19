/**
 * Settings-section wrapper for the MCPs surface (Cloud/Developer group mount).
 *
 * The settings-section registry renders a no-prop `Component`, so this is the
 * zero-prop adapter handed to `registerSettingsSection({ id: "mcps", Component:
 * McpsSection, ... })`. It reuses the exact same {@link McpsSurface} as the
 * standalone route, so the section and any direct mount stay identical.
 */

import { McpsSurface } from "./McpsRoute";

export function McpsSection() {
  return <McpsSurface />;
}
