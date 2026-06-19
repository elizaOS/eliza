/**
 * Settings-section / view wrapper for the Documents (Knowledge) surface
 * (Wave-3 mount point).
 *
 * Documents is an agent-scoped view (PLAN §"`dashboard/documents` → AGENT-VIEW
 * (Knowledge)"); the per-character selector is the scope. The settings-section
 * registry renders a no-prop `Component`, so this is the zero-prop adapter
 * Wave 3 hands to `registerSettingsSection({ id: "documents", Component:
 * DocumentsSection, ... })` (or mounts as a standalone view).
 *
 * It reuses the exact same {@link DocumentsSurface} as the standalone route, so
 * the section and any direct mount stay identical.
 */

import { DocumentsSurface } from "./DocumentsRoute";

export function DocumentsSection() {
  return <DocumentsSurface />;
}
