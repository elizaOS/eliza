/**
 * Classifies observable renderer changes for the bounded interaction smoke.
 * Transport activity cannot establish an interaction result; DOM changes are
 * activity observations only and never certify a committed domain operation.
 */
export type ControlDetails = {
  tagName: string;
  role: string | null;
  type: string | null;
  href: string | null;
  visible: boolean;
  label: string;
  text: string;
  value: string | null;
  checked: boolean | null;
  attributes: Record<string, string | null>;
};

export type ControlSnapshot = {
  url: string;
  visibleDismissibleSurfaces: number;
  pageFingerprint: string;
  details: ControlDetails | null;
};

export const CLICK_OBSERVED_ATTRIBUTES = [
  "data-agent-id",
  "data-chat-open",
  "aria-expanded",
  "aria-pressed",
  "aria-selected",
  "aria-current",
  "data-state",
  "data-open",
  "data-active",
  "data-selected",
  "data-value",
  "open",
] as const;

export function interactionDelta(
  before: ControlSnapshot,
  after: ControlSnapshot,
): string | null {
  if (after.url !== before.url) {
    return `URL changed from ${before.url} to ${after.url}`;
  }
  if (after.visibleDismissibleSurfaces !== before.visibleDismissibleSurfaces) {
    return `dismissible surface count changed ${before.visibleDismissibleSurfaces} -> ${after.visibleDismissibleSurfaces}`;
  }
  if (before.details && !after.details) {
    return "clicked control detached or was replaced";
  }
  if (!before.details || !after.details) {
    return null;
  }
  if (after.details.label !== before.details.label) {
    return `control label changed from "${before.details.label}" to "${after.details.label}"`;
  }
  if (after.details.visible !== before.details.visible) {
    return `control visibility changed ${String(before.details.visible)} -> ${String(after.details.visible)}`;
  }
  if (after.details.text !== before.details.text) {
    return `control text changed from "${before.details.text}" to "${after.details.text}"`;
  }
  if (after.details.checked !== before.details.checked) {
    return `checked state changed ${String(before.details.checked)} -> ${String(after.details.checked)}`;
  }
  if (after.details.value !== before.details.value) {
    return `value changed from "${String(before.details.value)}" to "${String(after.details.value)}"`;
  }
  for (const attr of CLICK_OBSERVED_ATTRIBUTES) {
    if (after.details.attributes[attr] !== before.details.attributes[attr]) {
      return `${attr} changed from "${String(before.details.attributes[attr])}" to "${String(after.details.attributes[attr])}"`;
    }
  }
  // Last-resort DOM-state signal: the outcome landed elsewhere in the page
  // (dial display, collapsed sidebar, flipped pager surface, toast).
  if (after.pageFingerprint !== before.pageFingerprint) {
    return `page content changed (${before.pageFingerprint} -> ${after.pageFingerprint})`;
  }
  return null;
}
