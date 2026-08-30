/**
 * Composes the plugin-owned Cloud dashboard with the shared shell navigation
 * primitive. Cloud owns its route chrome; the shell only mounts its registered
 * plugin surface.
 */

import { ViewHeader } from "@elizaos/ui/components";
import type { JSX } from "react";
import { CloudView } from "./CloudView.tsx";

export function CloudPage(): JSX.Element {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <ViewHeader title="Eliza Cloud" />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <CloudView />
      </div>
    </div>
  );
}
