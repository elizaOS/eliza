/**
 * Data + state wrapper around `Launcher`: reads the shared post-curation
 * launcher list (`useCuratedLauncherEntries` — the same list the desktop tray
 * and popover mirror) and wires tile taps to view navigation and chat-open.
 * `Launcher` itself is pure presentation — one flat grid, no favorites,
 * recents, or section zones.
 */
import { logger } from "@elizaos/logger";
import * as React from "react";
import { reportUserViewSwitch } from "../../chat/useSlashCommandController";
import { dispatchChatOpen } from "../../events";
import type { ViewEntry } from "../../hooks/view-catalog";
import { shellHistory } from "../../surface-realm-channel";
import { Launcher } from "./Launcher";
import { useCuratedLauncherEntries } from "./useCuratedLauncherEntries";

export const LauncherSurface = React.memo(
  function LauncherSurface(): React.JSX.Element {
    const { entries: page, loading } = useCuratedLauncherEntries();

    const handleLaunch = React.useCallback((entry: ViewEntry) => {
      const path = entry.path ?? `/apps/${entry.id}`;
      try {
        if (typeof window === "undefined") return;
        if (window.location.protocol === "file:") {
          window.location.hash = path;
        } else {
          shellHistory.pushState(null, "", path);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
        reportUserViewSwitch(entry.id, path);
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
