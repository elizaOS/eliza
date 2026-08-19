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
 * The complete 64x32 hit target is painted. The detached NSWindow uses these
 * same dimensions, so there is no transparent margin that can steal clicks.
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
      variant="ghost"
      {...props}
      className={cn(
        "pointer-events-auto flex h-8 w-16 shrink-0 items-center justify-center rounded-full border border-white/20 bg-[#181a20]/95 p-0 text-white shadow-none backdrop-blur-xl",
        "hover:bg-[#202228]/95 active:scale-95",
        "focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
        className,
      )}
    >
      {children ?? (
        <span
          aria-hidden="true"
          data-testid={markTestId}
          className={cn(
            "h-1.5 w-12 rounded-full bg-white/95 opacity-100",
            breathing && "eliza-chat-handle-breathe",
            markClassName,
          )}
          style={{ backgroundColor: "rgba(255, 255, 255, 0.96)" }}
        />
      )}
    </Button>
  );
}
