/**
 * Connectors page — curated connector view.
 */

import { PluginsView } from "./PluginsView";

export function ConnectorsPageView({ inModal }: { inModal?: boolean } = {}) {
  return (
    <div className="flex flex-col h-full">
      <PluginsView mode="social" inModal={inModal ?? true} />
    </div>
  );
}
