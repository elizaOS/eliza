/**
 * Composes the plugin-owned Notes view with the shared shell navigation
 * primitive. The page owns its route chrome so the app shell only mounts the
 * registered plugin surface and does not need Notes-specific knowledge.
 */

import { ViewHeader } from "@elizaos/ui/components";
import type { JSX } from "react";
import { NotesView } from "./NotesView.js";

export function NotesPage(): JSX.Element {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <ViewHeader title="Notes" />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <NotesView />
      </div>
    </div>
  );
}
