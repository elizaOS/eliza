import { getInternalToolAppDescriptors } from "@elizaos/ui/components/apps/internal-tool-apps";
import type { DesktopClickAuditItem } from "@elizaos/ui/utils/desktop-workspace";

interface DesktopTrayMenuItem {
  id: string;
  label?: string;
  /** i18n key for {@link label}; resolved at menu-build time. */
  labelKey?: string;
  type?: "normal" | "separator";
}

/**
 * Prefix for tray items that open an internal tool view in its own desktop
 * window (#10716). The renderer's `DesktopTrayRuntime` matches this prefix,
 * resolves the descriptor by slug, and opens the view window via the same
 * `eliza:navigate:view` bus the launcher uses — so the tray view list stays in
 * lockstep with the launcher catalog instead of duplicating a static list.
 */
export const TRAY_APP_ITEM_PREFIX = "tray-app-";

/** Stable tray-item slug for an internal tool app name (`@elizaos/x` → `x`). */
export function desktopTrayAppSlug(name: string): string {
  return name.replace(/^@elizaos\//, "");
}

/**
 * Tray "Views" items generated from the shared internal-tool-app catalog
 * (`getInternalToolAppDescriptors`), ordered by catalog `order`. Each opens the
 * view in its own window. Returned separately so callers can splice a
 * separator around the section.
 */
export function buildDesktopTrayViewItems(): DesktopTrayMenuItem[] {
  return [...getInternalToolAppDescriptors()]
    .filter((descriptor) => descriptor.windowPath !== null)
    .sort((a, b) => a.order - b.order)
    .map((descriptor) => ({
      id: `${TRAY_APP_ITEM_PREFIX}${desktopTrayAppSlug(descriptor.name)}`,
      label: descriptor.displayName,
    }));
}

export const DESKTOP_TRAY_MENU_ITEMS: readonly DesktopTrayMenuItem[] = [
  {
    id: "tray-open-chat",
    label: "Open Chat",
    labelKey: "desktop.tray.openChat",
  },
  {
    id: "tray-open-plugins",
    label: "Open Plugins",
    labelKey: "desktop.tray.openPlugins",
  },
  {
    id: "tray-open-desktop-workspace",
    label: "Open Desktop Workspace",
    labelKey: "desktop.tray.openDesktopWorkspace",
  },
  {
    id: "tray-open-voice-controls",
    label: "Open Voice Controls",
    labelKey: "desktop.tray.openVoiceControls",
  },
  { id: "tray-sep-0", type: "separator" },
  {
    id: "tray-toggle-lifecycle",
    label: "Start/Stop Agent",
    labelKey: "desktop.tray.toggleLifecycle",
  },
  {
    id: "tray-restart",
    label: "Restart Agent",
    labelKey: "desktop.tray.restartAgent",
  },
  {
    id: "tray-notify",
    label: "Send Test Notification",
    labelKey: "desktop.tray.sendTestNotification",
  },
  { id: "tray-sep-1", type: "separator" },
  {
    id: "tray-show-window",
    label: "Show Window",
    labelKey: "desktop.tray.showWindow",
  },
  {
    id: "tray-hide-window",
    label: "Hide Window",
    labelKey: "desktop.tray.hideWindow",
  },
  { id: "tray-sep-2", type: "separator" },
  { id: "quit", label: "Quit", labelKey: "desktop.tray.quit" },
] as const;

/**
 * Build the tray menu with labels translated by `t`. Separators and any item
 * without a `labelKey` pass through unchanged. A generated "Views" section
 * (one item per internal tool view, each opening its own window — #10716) is
 * spliced in after the fixed open-surface items. The native tray is rebuilt
 * from this at desktop boot, so it reflects the resolved UI language.
 */
export function buildLocalizedTrayMenu(
  t: (key: string, vars?: { defaultValue?: string }) => string,
): DesktopTrayMenuItem[] {
  const localize = (item: DesktopTrayMenuItem): DesktopTrayMenuItem =>
    item.labelKey
      ? { ...item, label: t(item.labelKey, { defaultValue: item.label }) }
      : { ...item };

  const viewItems = buildDesktopTrayViewItems();
  const viewsSection: DesktopTrayMenuItem[] =
    viewItems.length > 0
      ? [{ id: "tray-sep-views", type: "separator" }, ...viewItems]
      : [];

  const result: DesktopTrayMenuItem[] = [];
  for (const item of DESKTOP_TRAY_MENU_ITEMS) {
    result.push(localize(item));
    if (item.id === "tray-open-voice-controls") {
      result.push(...viewsSection);
    }
  }
  return result;
}

export const DESKTOP_TRAY_CLICK_AUDIT: readonly DesktopClickAuditItem[] = [
  {
    id: "tray-open-chat",
    entryPoint: "tray",
    label: "Open Chat",
    expectedAction: "Show and focus the main window, then switch to chat.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-open-plugins",
    entryPoint: "tray",
    label: "Open Plugins",
    expectedAction: "Show and focus the main window, then switch to plugins.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-open-desktop-workspace",
    entryPoint: "tray",
    label: "Open Desktop Workspace",
    expectedAction:
      "Open a detached settings window focused on the desktop workspace section.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-open-voice-controls",
    entryPoint: "tray",
    label: "Open Voice Controls",
    expectedAction:
      "Open a detached settings window focused on the voice controls section.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-toggle-lifecycle",
    entryPoint: "tray",
    label: "Start/Stop Agent",
    expectedAction: "Start a stopped agent or stop a running agent.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-restart",
    entryPoint: "tray",
    label: "Restart Agent",
    expectedAction: "Restart the desktop agent runtime.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-notify",
    entryPoint: "tray",
    label: "Send Test Notification",
    expectedAction: "Emit a desktop notification from the renderer.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-show-window",
    entryPoint: "tray",
    label: "Show Window",
    expectedAction: "Show and focus the main desktop window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "tray-hide-window",
    entryPoint: "tray",
    label: "Hide Window",
    expectedAction: "Hide the main desktop window.",
    runtimeRequirement: "desktop",
    coverage: "automated",
  },
  {
    id: "quit",
    entryPoint: "tray",
    label: "Quit",
    expectedAction: "Quit the desktop application.",
    runtimeRequirement: "desktop",
    coverage: "manual",
  },
] as const;
