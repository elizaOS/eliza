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

    const handleLaunch = React.useCallback((entry: ViewEntry) => {
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
      } catch {
        // Sandboxed navigation is best-effort.
      }
    }, []);

    return (
      <div className="absolute inset-0 flex min-h-0 flex-col px-0 pb-[calc(var(--eliza-mobile-nav-offset,0px)+max(var(--safe-area-bottom,0px),var(--android-gesture-inset-bottom,0px))+var(--eliza-continuous-chat-clearance,5.25rem)+1.75rem)]">
        <Launcher entries={entries} loading={loading} onLaunch={handleLaunch} />
      </div>
    );
  },
);
