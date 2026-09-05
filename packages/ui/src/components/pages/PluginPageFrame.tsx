/**
 * Shared full-height page chrome for plugin-owned views, pairing the canonical
 * shell header with an explicitly scrollable or clipped content region.
 */

import type { ReactNode } from "react";
import { ViewHeader } from "../shared/ViewHeader";

export interface PluginPageFrameProps {
  title: string;
  children: ReactNode;
  contentOverflow?: "auto" | "hidden";
  safeAreaTop?: boolean;
}

export function PluginPageFrame({
  title,
  children,
  contentOverflow = "hidden",
  safeAreaTop = false,
}: PluginPageFrameProps): React.JSX.Element {
  return (
    <div
      className={`flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden${
        safeAreaTop ? " pt-[var(--safe-area-top,0px)]" : ""
      }`}
    >
      <ViewHeader title={title} />
      <div
        className={`min-h-0 min-w-0 flex-1 ${
          contentOverflow === "auto" ? "overflow-y-auto" : "overflow-hidden"
        }`}
      >
        {children}
      </div>
    </div>
  );
}
