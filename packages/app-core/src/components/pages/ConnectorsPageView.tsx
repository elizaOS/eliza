/**
 * Connectors page — curated connector view.
 */

import { PluginsView } from "./PluginsView";

export function ConnectorsPageView({ inModal }: { inModal?: boolean } = {}) {
  return <PluginsView mode="social" inModal={inModal ?? false} />;
}
