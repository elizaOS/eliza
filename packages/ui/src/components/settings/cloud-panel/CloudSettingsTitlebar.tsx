/**
 * Cloud settings titlebar — intentionally empty.
 *
 * The settings window now uses the real native titlebar
 * (titleBarStyle: "default" in surface-windows.ts), so there
 * is no need for HTML-rendered window controls. This component
 * is kept as a no-op for compatibility with CloudSettingsPanel.
 */
export function CloudSettingsTitlebar() {
  return null;
}
