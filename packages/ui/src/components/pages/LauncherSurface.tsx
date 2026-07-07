/**
 * Data + state wrapper around `Launcher`: pulls the routable views, filters them
 * by the user's enabled view kinds and active modality, curates them into the
 * ordered page (`curateLauncherPages`), and wires tile taps to view navigation
 * and chat-open. `Launcher` itself is pure presentation — one flat grid, no
 * favorites, recents, or section zones.
 */
import { logger } from "@elizaos/logger";
import * as React from "react";
import { dispatchChatOpen } from "../../events";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import { type ViewEntry, viewToEntry } from "../../hooks/view-catalog";
import { isAospShellEnabled } from "../../navigation";
import { getActiveViewModality } from "../../platform/platform-guards";
import { useAppSelectorShallow } from "../../state";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { Launcher } from "./Launcher";
import { curateLauncherPages } from "./launcher-curation";

export const LauncherSurface = React.memo(
  function LauncherSurface(): React.JSX.Element {
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

    const page = React.useMemo<ViewEntry[]>(
      () =>
        curateLauncherPages(modalEntries, {
          isAosp,
          enabledKinds,
          cloudActive: elizaCloudConnected,
        }),
      [modalEntries, isAosp, enabledKinds, elizaCloudConnected],
    );

    const handleLaunch = React.useCallback((entry: ViewEntry) => {
      const path = entry.path ?? `/apps/${entry.id}`;
      try {
        if (typeof window === "undefined") return;
        if (window.location.protocol === "file:") {
          window.location.hash = path;
        } else {
          window.history.pushState(null, "", path);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
        if (entry.id === "chat") {
          // The Messages tile lands on `/chat` (the ambient home). Open the chat
          // so the user arrives in a conversation, not on a collapsed pill.
          dispatchChatOpen();
        }
      } catch (err) {
        // error-policy:J4 sandboxed webviews (embeds) can reject history
        // navigation with a SecurityError; the tile tap degrades to a no-op
        // there. Logged so a launcher that silently stops navigating is
        // diagnosable.
        logger.warn({ err, path }, "[LauncherSurface] tile navigation failed");
      }
    }, []);

    return (
      <div className="absolute inset-0 flex min-h-0 flex-col px-0 pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-continuous-chat-clearance,5.25rem)+1.75rem)]">
        <Launcher entries={page} loading={loading} onLaunch={handleLaunch} />
      </div>
    );
  },
);
