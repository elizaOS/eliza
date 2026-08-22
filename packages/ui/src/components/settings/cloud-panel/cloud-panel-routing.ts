/**
 * Hash routing for the cloud settings panel.
 *
 * Reads and writes the `#<section-id>` hash so deep links work and the
 * panel remembers the last-viewed section across restarts.
 */
import { resolveCloudPanelSection } from "./cloud-panel-sections";

/** Read the current section id from the URL hash. */
export function readCloudPanelHash(): string {
  if (typeof window === "undefined") return "general";
  const hash = window.location.hash.replace(/^#/, "");
  return resolveCloudPanelSection(hash || null);
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

/** Subscribe to hash changes. Returns an unsubscribe function. */
export function subscribeCloudPanelHash(
  listener: (sectionId: string) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = () => listener(readCloudPanelHash());
  window.addEventListener("hashchange", handler);
  return () => window.removeEventListener("hashchange", handler);
}
