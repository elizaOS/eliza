/**
 * Chat-sidebar widget registration for the browser-workspace status widget.
 * Split from the component so the registry entry imports without pulling the
 * component's render dependencies.
 */
import { BrowserStatusSidebarWidget } from "./browser-status";
import type { ChatSidebarWidgetDefinition } from "./types";

export const BROWSER_STATUS_WIDGET: ChatSidebarWidgetDefinition = {
  id: "browser.status",
  pluginId: "browser-workspace",
  order: 75,
  defaultEnabled: true,
  Component: BrowserStatusSidebarWidget,
};
