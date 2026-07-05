/**
 * Data + state wrapper around `Launcher`: pulls the routable views, filters them
 * by the user's enabled view kinds and active modality, curates them into the
 * ordered page (`curateLauncherPages`), partitions that page into the named
 * Recents/Favorites/All-Apps zones (`curateLauncherZones`), and wires tile taps
 * to view navigation, chat-open, and the tutorial start. It owns the launcher's
 * Recents/Favorites state (view-id keyed, persisted locally) so a tap records
 * recency and a pin toggles a favorite. `Launcher` itself is pure presentation.
 */
import { logger } from "@elizaos/logger";
import * as React from "react";
import { dispatchChatOpen } from "../../events";
import { useRoutableViews } from "../../hooks/useAvailableViews";
import { type ViewEntry, viewToEntry } from "../../hooks/view-catalog";
import { isAospShellEnabled } from "../../navigation";
import { getActiveViewModality } from "../../platform/platform-guards";
import { useAppSelectorShallow } from "../../state";
import {
  loadLauncherFavorites,
  recordLauncherRecent,
  saveLauncherFavorites,
} from "../../state/persistence";
import { useEnabledViewKinds } from "../../state/useViewKinds";
import { Launcher } from "./Launcher";
import {
  canonicalLauncherId,
  curateLauncherPages,
  curateLauncherZones,
  LAUNCHER_RECENTS_ZONE_LIMIT,
} from "./launcher-curation";
import { startTutorial } from "./tutorial/tutorial-controller";

export const LauncherSurface = React.memo(
  function LauncherSurface(): React.JSX.Element {
    const { views, loading } = useRoutableViews();
    const enabledKinds = useEnabledViewKinds();
    const { elizaCloudConnected } = useAppSelectorShallow((state) => ({
      elizaCloudConnected: state.elizaCloudConnected,
    }));
    const activeModality = React.useMemo(() => getActiveViewModality(), []);
    const isAosp = React.useMemo(() => isAospShellEnabled(), []);

    const [recentIds, setRecentIds] = React.useState<string[]>([]);
    const [favoriteIds, setFavoriteIds] = React.useState<string[]>(() =>
      loadLauncherFavorites(),
    );
    const favoriteIdSet = React.useMemo(
      () => new Set(favoriteIds),
      [favoriteIds],
    );

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

    const zones = React.useMemo(
      () =>
        curateLauncherZones(page, {
          recentIds,
          favoriteIds,
          recentsLimit: LAUNCHER_RECENTS_ZONE_LIMIT,
        }),
      [page, recentIds, favoriteIds],
    );

    const handleToggleFavorite = React.useCallback((entry: ViewEntry) => {
      const id = canonicalLauncherId(entry.id);
      setFavoriteIds((current) => {
        const next = current.includes(id)
          ? current.filter((x) => x !== id)
          : [...current, id];
        saveLauncherFavorites(next);
        return next;
      });
    }, []);

    const handleLaunch = React.useCallback((entry: ViewEntry) => {
      setRecentIds(recordLauncherRecent(canonicalLauncherId(entry.id)));
      // The Tutorial tile skips the TutorialView splash: start the interactive
      // tour directly and land on the chat home so it overlays the real chat.
      const isTutorial = entry.id === "tutorial";
      const path = isTutorial ? "/chat" : (entry.path ?? `/apps/${entry.id}`);
      try {
        if (typeof window === "undefined") return;
        if (window.location.protocol === "file:") {
          window.location.hash = path;
        } else {
          window.history.pushState(null, "", path);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
        if (isTutorial) {
          startTutorial();
        } else if (entry.id === "chat") {
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
        <Launcher
          zones={zones}
          loading={loading}
          onLaunch={handleLaunch}
          onToggleFavorite={handleToggleFavorite}
          favoriteIds={favoriteIdSet}
        />
      </div>
    );
  },
);
