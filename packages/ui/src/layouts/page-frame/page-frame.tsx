/**
 * Renders the canonical page-width, gutter, and scroll boundary for a resolved
 * page layout manifest. The neutral default avoids adding a second main
 * landmark when a host shell already owns one.
 */

import type { PageLayoutManifest } from "@elizaos/core";
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
  useCallback,
} from "react";

import { cn } from "../../lib/utils";

const PAGE_WIDTH_CLASS = {
  reading: "max-w-3xl",
  standard: "max-w-5xl",
  wide: "max-w-7xl",
  full: "max-w-none",
} satisfies Record<PageLayoutManifest["width"], string>;

const PAGE_GUTTER_CLASS = {
  none: undefined,
  standard: "px-4 sm:px-6 lg:px-8",
} satisfies Record<"none" | "standard", string | undefined>;

export type PageFrameElement = "div" | "main";

export interface PageFrameProps
  extends Omit<HTMLAttributes<HTMLElement>, "children"> {
  /** Resolved page topology supplied by the surface manifest. */
  layout: PageLayoutManifest;
  /** Root landmark. Defaults to `div` so host shells can retain their `main`. */
  as?: PageFrameElement;
  /** Page content. Views with `scroll: "view"` provide their own scroller here. */
  children: ReactNode;
  /** Placement-only classes for the width-constrained content boundary. */
  contentClassName?: string;
}

/**
 * Owns page geometry while leaving content structure and view-owned scrolling
 * to its children. Stable data markers make the resolved policy observable to
 * audit tooling and host integrations.
 */
export const PageFrame = forwardRef<HTMLElement, PageFrameProps>(
  function PageFrame(
    {
      as: Component = "div",
      children,
      className,
      contentClassName,
      layout,
      ...props
    },
    ref,
  ) {
    if (layout.topology === "ambient") {
      throw new Error(
        "PageFrame cannot render an ambient layout; the ambient host owns that topology",
      );
    }
    const gutter = layout.gutter ?? "standard";
    const setRootRef = useCallback(
      (node: HTMLElement | null) => {
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [ref],
    );

    return (
      <Component
        {...props}
        ref={setRootRef}
        className={cn(
          className,
          "relative flex min-h-0 min-w-0 w-full flex-1 flex-col",
          layout.scroll === "shell"
            ? "chat-native-scrollbar overflow-y-auto overscroll-contain"
            : "overflow-hidden",
        )}
        data-page-kind={layout.kind}
        data-page-topology={layout.topology ?? "framed"}
        data-page-width={layout.width}
        data-scroll-owner={layout.scroll}
      >
        <div
          className={cn(
            contentClassName,
            "mx-auto flex min-h-0 min-w-0 w-full flex-1 flex-col",
            PAGE_WIDTH_CLASS[layout.width],
            PAGE_GUTTER_CLASS[gutter],
            layout.scroll === "view" && "overflow-hidden",
          )}
          data-page-content=""
          data-page-gutter={gutter}
        >
          {children}
        </div>
      </Component>
    );
  },
);

PageFrame.displayName = "PageFrame";
