/**
 * Compact browser-workspace widget for the chat-sidebar.
 *
 * Polls the workspace snapshot and renders a compact list of open tabs with
 * a status indicator per tab (visible / background). Returns null when no
 * tabs are open — the widget keeps the right rail quiet until the user
 * actually has browser state.
 *
 * Title-click opens /browser. Tab-click focuses that tab via the backend.
 */
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./types";
export declare function BrowserStatusSidebarWidget(
  _props: ChatSidebarWidgetProps,
): import("react/jsx-runtime").JSX.Element | null;
export declare const BROWSER_STATUS_WIDGET: ChatSidebarWidgetDefinition;
//# sourceMappingURL=browser-status.d.ts.map
