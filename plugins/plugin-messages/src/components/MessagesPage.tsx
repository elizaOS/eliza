/**
 * Owns the Messages page chrome in the plugin that owns the SMS surface.
 * The app shell supplies lifecycle and agent-surface wiring; this wrapper
 * supplies the consistent launcher back affordance for the fullscreen view.
 */

import { ViewHeader } from "@elizaos/ui/components";
import { MessagesView } from "./MessagesView.tsx";

export function MessagesPage(): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <ViewHeader title="Messages" />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <MessagesView />
      </div>
    </div>
  );
}
