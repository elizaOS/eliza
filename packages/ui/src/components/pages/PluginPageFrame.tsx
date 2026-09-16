/**
 * Shared full-height page chrome for plugin-owned views, pairing the canonical
 * shell header with an explicitly scrollable or clipped content region.
 */

import type { ReactNode } from "react";
import { FramedPage } from "../../layouts/framed-page";
import { ViewHeader } from "../shared/ViewHeader";
import { ScrollArea } from "../ui/scroll-area";

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
    <FramedPage
      gutterOwner="framed-page"
      reserveComposer={contentOverflow === "auto"}
      className={`overflow-hidden${
        safeAreaTop ? " pt-[var(--safe-area-top,0px)]" : ""
      }`}
    >
      <ViewHeader title={title} />
      {contentOverflow === "auto" ? (
        <section aria-label={title} className="min-h-0 min-w-0 flex-1">
          {/* Vertical pages must wrap their content instead of inheriting Radix's intrinsic table width. */}
          <ScrollArea
            className="h-full min-w-0"
            viewportClassName="[&>div]:!block"
          >
            {children}
          </ScrollArea>
        </section>
      ) : (
        <section
          aria-label={title}
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          {children}
        </section>
      )}
    </FramedPage>
  );
}
