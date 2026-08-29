/**
 * Router-owned content frame for a routed app workspace.
 *
 * This is intentionally narrower than a general page shell: views still own
 * their domain layout, while the router makes one explicit decision about
 * whether the page scrolls here or inside the view and reserves floating-chat
 * clearance at that same boundary.
 */
import type { PageLayoutManifest } from "@elizaos/core";
import type React from "react";
import type { ReactNode } from "react";
import { PageFrame } from "../../layouts/page-frame";
import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { AppWorkspaceChrome } from "./AppWorkspaceChrome";

const CHAT_CLEARANCE_CLASS = "pb-[var(--eliza-chat-clearance,5.25rem)]";

export type AppWorkspaceContentLayout = "contained" | "scroll";

export interface AppWorkspaceContentProps {
  children: ReactNode;
  /** Optional route header rendered ahead of the workspace content. */
  header?: ReactNode;
  /** Local scroll boundary used when no canonical page layout is supplied. */
  layout?: AppWorkspaceContentLayout;
  /** Canonical route/view layout; when present, its scroll policy wins. */
  pageLayout?: PageLayoutManifest;
  /** Optional navigation region rendered above the workspace content. */
  nav?: ReactNode;
  /**
   * Reserve room for the global floating composer. Fullscreen/immersive views
   * opt out because they intentionally fill behind the overlay.
   */
  reserveChatClearance?: boolean;
  /** Background surface delegated to AppWorkspaceChrome. */
  surface?: "opaque" | "transparent";
  /** Additional classes applied to the content or scroll region. */
  className?: string;
}

/**
 * Compose router chrome with exactly one content lifecycle boundary.
 *
 * A canonical `pageLayout` delegates geometry and scroll ownership to
 * `PageFrame`. The legacy `layout` branches remain for callers that have not
 * migrated: `contained` leaves scrolling to the view, while `scroll` owns a
 * local scroller and keeps its header outside that boundary.
 */
export function AppWorkspaceContent({
  children,
  header,
  layout = "contained",
  nav,
  pageLayout,
  reserveChatClearance = true,
  surface = "transparent",
  className,
}: AppWorkspaceContentProps): React.JSX.Element {
  const clearanceClass = reserveChatClearance
    ? CHAT_CLEARANCE_CLASS
    : undefined;

  const framedChildren = pageLayout ? (
    <PageFrame
      contentClassName={cn(clearanceClass, className)}
      layout={pageLayout}
    >
      {header ? (
        <>
          {header}
          <div
            className={cn(
              "min-w-0 w-full flex-1",
              pageLayout.scroll === "view" && "min-h-0 overflow-hidden",
            )}
          >
            {children}
          </div>
        </>
      ) : (
        children
      )}
    </PageFrame>
  ) : null;

  const main = pageLayout ? (
    <div
      data-shell-content-region={
        pageLayout.scroll === "view" ? "true" : undefined
      }
      data-shell-scroll-region={
        pageLayout.scroll === "shell" ? "true" : undefined
      }
      className="eliza-chat-scroll flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden"
    >
      {framedChildren}
    </div>
  ) : layout === "scroll" ? (
    header ? (
      <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden">
        {header}
        <ScrollArea
          data-shell-scroll-region="true"
          className="min-h-0 min-w-0 w-full flex-1"
          viewportClassName={cn(
            "eliza-chat-scroll overflow-y-auto",
            clearanceClass,
            className,
          )}
        >
          {children}
        </ScrollArea>
      </div>
    ) : (
      <ScrollArea
        data-shell-scroll-region="true"
        className="min-h-0 min-w-0 w-full flex-1"
        viewportClassName={cn(
          "eliza-chat-scroll overflow-y-auto",
          clearanceClass,
          className,
        )}
      >
        {children}
      </ScrollArea>
    )
  ) : (
    <div
      data-shell-content-region="true"
      className={cn(
        "eliza-chat-scroll flex min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden",
        clearanceClass,
        className,
      )}
    >
      {header ? (
        <>
          {header}
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {children}
          </div>
        </>
      ) : (
        children
      )}
    </div>
  );

  return (
    <AppWorkspaceChrome
      testId={
        (pageLayout ? pageLayout.scroll === "shell" : layout === "scroll")
          ? "tab-scroll-view"
          : "tab-content-view"
      }
      surface={surface}
      nav={nav}
      main={main}
    />
  );
}
