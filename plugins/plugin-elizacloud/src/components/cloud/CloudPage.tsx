/**
 * Composes the plugin-owned Cloud dashboard with the shared shell navigation
 * primitive. Cloud owns its route chrome; the shell only mounts its registered
 * plugin surface.
 */

import { PluginPageFrame } from "@elizaos/ui/components";
import type { JSX } from "react";
import { CloudView, type CloudViewProps } from "./CloudView.tsx";

export function CloudPage(props: CloudViewProps = {}): JSX.Element {
  return (
    <PluginPageFrame title="Eliza Cloud">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <CloudView {...props} showTitle={false} />
      </div>
    </PluginPageFrame>
  );
}
