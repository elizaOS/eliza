/**
 * Owns the Messages page chrome in the plugin that owns the SMS surface.
 * The app shell supplies lifecycle and agent-surface wiring; this wrapper
 * supplies the consistent launcher back affordance for the fullscreen view.
 */

import { PluginPageFrame } from "@elizaos/ui/components";
import { MessagesView } from "./MessagesView.tsx";

export function MessagesPage(): React.JSX.Element {
  return (
    <PluginPageFrame title="Messages" contentOverflow="auto">
      <MessagesView />
    </PluginPageFrame>
  );
}
