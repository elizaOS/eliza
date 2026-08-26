/**
 * Composes the plugin-owned Maps view with the shared shell navigation
 * primitive. Maps owns its route chrome; the app shell only mounts the
 * registered plugin surface.
 */

import { ViewHeader } from "@elizaos/ui/components";
import type { JSX } from "react";
import { MapsView } from "./MapsView.tsx";

export function MapsPage(): JSX.Element {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <ViewHeader title="Maps" />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <MapsView />
      </div>
    </div>
  );
}
