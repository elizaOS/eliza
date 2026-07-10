/**
 * Fixture for the transcript search-to-player deep-link `__e2e__` (#14806):
 * mounts the REAL DocumentsView (search list, anchor badges, reader push
 * sub-view, word-synced TranscriptPlayer) full-bleed. The runner bundles it
 * with the client/state stubs substituted at the module boundary and drives
 * the flow through `window.__viewChatBinding` + real clicks.
 */

import { createRoot } from "react-dom/client";
import { DocumentsView } from "../DocumentsView";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("fixture root missing");
rootEl.className = "h-full bg-bg text-txt";

createRoot(rootEl).render(
  <div className="flex h-full min-h-0 flex-col p-4">
    <DocumentsView standalone />
  </div>,
);
