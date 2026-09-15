/**
 * No-op typed app-navigation seam for isolated calendar screenshots.
 *
 * Production routing is covered in component tests; this harness keeps
 * connector actions offline while rendering their visible affordances.
 */

export function dispatchFocusConnector(_connectorId: string): void {}

export function dispatchNavigateViewEvent(_detail: {
  viewId?: string;
  viewPath?: string | null;
  subview?: string;
}): void {}

export const VIEW_EVENTS = {
  VIEW_REFRESH: "view:refresh",
} as const;

export function useViewEvent(
  _eventType: string,
  _handler: () => void,
  _deps: readonly unknown[],
): void {}
