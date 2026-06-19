import { BrowserStatusSidebarWidget } from "./browser-status";
import type { ChatSidebarWidgetDefinition } from "./types";

export const BROWSER_STATUS_WIDGET: ChatSidebarWidgetDefinition = {
  id: "browser.status",
  pluginId: "browser-workspace",
  order: 75,
  defaultEnabled: true,
  Component: BrowserStatusSidebarWidget,
};
