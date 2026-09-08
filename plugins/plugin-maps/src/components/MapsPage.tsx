/**
 * Composes the plugin-owned Maps view with the shared shell navigation
 * primitive. Maps owns its route chrome; the app shell only mounts the
 * registered plugin surface.
 */

import { PluginPageFrame } from "@elizaos/ui/components";
import type { JSX } from "react";
import { MapsView } from "./MapsView.tsx";

export function MapsPage(): JSX.Element {
  return (
    <PluginPageFrame title="Maps">
      <MapsView />
    </PluginPageFrame>
  );
}
