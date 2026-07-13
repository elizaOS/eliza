/**
 * The single post-curation launcher list, as a reusable hook. LauncherSurface
 * renders it as the tile grid; the desktop host (DesktopTrayRuntime in
 * @elizaos/app-core) mirrors it into the native tray "Views" submenu and the
 * macOS tray-popover rows — every OS views surface shows exactly what the
 * launcher shows, with the same visibility gates (view-kind toggles, AOSP
 * gating, cloud gating, hidden ids, alias canonicalization). Derivation:
 * routable views → active-modality filter → ViewEntry → curateLauncherPages.
 */
import * as React from "react";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import { type ViewEntry, viewToEntry } from "../../hooks/view-catalog";
import { isAospShellEnabled } from "../../navigation";
import { getActiveViewModality } from "../../platform/platform-guards";
import { useAppSelectorShallow } from "../../state";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { curateLauncherPages } from "./launcher-curation";

export interface CuratedLauncherEntriesResult {
  /** Ordered, deduped, visibility-gated launcher entries. */
  entries: ViewEntry[];
  /** True while the view registry's first network read is in flight. */
  loading: boolean;
}

// Packaged-desktop e2e diagnostics seam (desktop-tray-views.e2e.spec.ts): the
// bridge `eval` has no ESM import path into the renderer bundle, so the latest
// curated list is mirrored onto a well-known global — same pattern as
// `shell-surface-store`. Read-only from the outside; never used by app code.
const CURATED_LAUNCHER_DIAGNOSTICS_KEY = Symbol.for(
  "elizaos.ui.curated-launcher",
);

export function useCuratedLauncherEntries(): CuratedLauncherEntriesResult {
  const { views, loading } = useRoutableViews();
  const enabledKinds = useEnabledViewKinds();
  const { elizaCloudConnected } = useAppSelectorShallow((state) => ({
    elizaCloudConnected: state.elizaCloudConnected,
  }));
  const activeModality = React.useMemo(() => getActiveViewModality(), []);
  const isAosp = React.useMemo(() => isAospShellEnabled(), []);

  // The launcher renders the loaded views for the active modality; the curation
  // layer owns removal, dedup, AOSP-gating, and developer/preview visibility.
  const modalEntries = React.useMemo(
    () =>
      views
        .filter((view) => (view.viewType ?? "gui") === activeModality)
        .map(viewToEntry),
    [activeModality, views],
  );

  const entries = React.useMemo<ViewEntry[]>(
    () =>
      curateLauncherPages(modalEntries, {
        isAosp,
        enabledKinds,
        cloudActive: elizaCloudConnected,
      }),
    [modalEntries, isAosp, enabledKinds, elizaCloudConnected],
  );

  React.useEffect(() => {
    (globalThis as Record<PropertyKey, unknown>)[
      CURATED_LAUNCHER_DIAGNOSTICS_KEY
    ] = {
      entries: entries.map(({ id, label, path }) => ({ id, label, path })),
    };
  }, [entries]);

  return React.useMemo(() => ({ entries, loading }), [entries, loading]);
}
