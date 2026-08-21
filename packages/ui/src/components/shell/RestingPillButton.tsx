/** Renders the canonical visible resting pill for embedded and native chat. */

import type * as React from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

type RestingPillButtonProps = React.ComponentProps<typeof Button> & {
  breathing?: boolean;
  markClassName?: string;
  markTestId?: string;
};

/**
 * Embedded surfaces use the compact 48x6 bar. The detached desktop caller
 * paints a larger capsule and gives its NSWindow those same exact dimensions,
 * so there is never an invisible click-blocking halo around either form.
 */
export function RestingPillButton({
  breathing = false,
  markClassName,
  markTestId,
  className,
  children,
  ...props
}: RestingPillButtonProps): React.JSX.Element {
  return (
    <Button
      unstyled
      {...props}
      className={cn(
        "pointer-events-auto flex h-1.5 w-12 shrink-0 items-center justify-center rounded-full border-0 bg-transparent p-0 text-white shadow-none outline-none",
        "active:scale-95",
        className,
      )}
    >
      {children ?? (
        <span
          aria-hidden="true"
          data-testid={markTestId}
          className={cn(
            "h-full w-full rounded-full bg-white/95 opacity-100",
            breathing && "eliza-chat-handle-breathe",
            markClassName,
          )}
          style={{ backgroundColor: "rgba(255, 255, 255, 0.96)" }}
        />
      )}
    </Button>
  );
}
