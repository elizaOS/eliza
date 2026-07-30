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
