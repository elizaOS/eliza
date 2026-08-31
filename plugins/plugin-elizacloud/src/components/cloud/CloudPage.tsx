/**
 * Composes the plugin-owned Cloud dashboard with the shared shell navigation
 * primitive. Cloud owns its route chrome; the shell only mounts its registered
 * plugin surface.
 */

import { PluginPageFrame } from "@elizaos/ui/components";
import type { JSX } from "react";
import { CloudView } from "./CloudView.tsx";

export function CloudPage(): JSX.Element {
  return (
    <PluginPageFrame title="Eliza Cloud">
      <CloudView />
    </PluginPageFrame>
  );
}
