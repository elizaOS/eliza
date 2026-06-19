/**
 * Plugins view — plugin management surface.
 */

import type { ReactNode } from "react";

import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { PluginsView } from "./PluginsView";

export function PluginsPageView({
  contentHeader,
  inModal,
}: {
  contentHeader?: ReactNode;
  inModal?: boolean;
} = {}) {
  return (
    <ShellViewAgentSurface viewId="plugins-page">
      <PluginsView
        contentHeader={contentHeader}
        mode="all-social"
        inModal={inModal ?? false}
      />
    </ShellViewAgentSurface>
  );
}
