/**
 * Routes calendar source recovery through the app's typed settings handoff.
 *
 * Google is the only calendar provider with a registered connector focus ID;
 * callers leave other providers visibly unavailable instead of inventing a
 * destination.
 */

import {
  dispatchFocusConnector,
  dispatchNavigateViewEvent,
} from "@elizaos/ui/events";

export function openCalendarConnectorSettings(connectorId?: "google"): void {
  if (connectorId) dispatchFocusConnector(connectorId);
  dispatchNavigateViewEvent({
    viewId: "settings",
    viewPath: "/settings",
    subview: "connectors",
  });
}
