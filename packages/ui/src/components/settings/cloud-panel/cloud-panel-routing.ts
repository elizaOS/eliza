/**
 * Hash routing for the cloud settings panel.
 *
 * Reads `/settings/<section-id>` paths and `#<section-id>` hashes so deep links
 * work across both app-shell route forms. Writes remain hash-based so existing
 * settings navigation and restart persistence retain their stable contract.
 */
import {
  readSettingsLocationRoute,
  subscribeSettingsLocation,
} from "../settings-route";
import { resolveCloudPanelSection } from "./cloud-panel-sections";

/** Whether the current location explicitly addresses a settings section. */
export function hasCloudPanelSectionRoute(): boolean {
  return readSettingsLocationRoute().kind !== "hub";
}

/** Read the current section id from the URL hash. */
export function readCloudPanelHash(): string {
  const route = readSettingsLocationRoute();
  return resolveCloudPanelSection(
    route.kind === "hub" ? null : route.sectionId,
  );
}

/** Navigate to a section by updating the URL hash. */
export function navigateCloudPanel(sectionId: string): void {
  if (typeof window === "undefined") return;
  const resolved = resolveCloudPanelSection(sectionId);
  const target = `#${resolved}`;
  if (window.location.hash !== target) {
    window.location.hash = target;
  }
}

/** Replace the current history entry with a section hash. */
export function replaceCloudPanel(sectionId: string): void {
  if (typeof window === "undefined") return;
  const resolved = resolveCloudPanelSection(sectionId);
  const target = `#${resolved}`;
  if (window.location.hash !== target) {
    window.history.replaceState(window.history.state, "", target);
  }
}

/** Subscribe to hash changes. Returns an unsubscribe function. */
export function subscribeCloudPanelHash(
  listener: (sectionId: string) => void,
): () => void {
  return subscribeSettingsLocation((route) =>
    listener(
      resolveCloudPanelSection(route.kind === "hub" ? null : route.sectionId),
    ),
  );
}
