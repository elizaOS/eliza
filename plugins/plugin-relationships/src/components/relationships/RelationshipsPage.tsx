/**
 * Composes the plugin-owned Relationships view with the shared shell navigation
 * primitive. The plugin owns its route chrome; the app shell only mounts the
 * registered plugin surface.
 */

import { ViewHeader } from "@elizaos/ui/components";
import type { JSX } from "react";
import { RelationshipsView } from "./RelationshipsView.tsx";

export function RelationshipsPage(): JSX.Element {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <ViewHeader title="Relationships" />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <RelationshipsView />
      </div>
    </div>
  );
}
