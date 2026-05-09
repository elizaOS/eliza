/**
 * Plugins view — plugin management surface.
 */

import type { ReactNode } from "react";

import { PluginsView } from "./PluginsView";

export function PluginsPageView({
  contentHeader,
  inModal,
}: {
  contentHeader?: ReactNode;
  inModal?: boolean;
} = {}) {
  return (
    <PluginsView
      contentHeader={contentHeader}
      mode="all-social"
      inModal={inModal ?? false}
    />
  );
}
