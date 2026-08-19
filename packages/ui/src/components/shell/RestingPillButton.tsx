/**
 * Renders the canonical resting-pill surface shared by embedded chat and the
 * exact-size detached native host.
 */

import type * as React from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

type RestingPillButtonProps = React.ComponentProps<typeof Button> & {
  breathing?: boolean;
  markClassName?: string;
  markTestId?: string;
};

/**
 * Canonical resting surface used by both the app overlay and the detached
 * native host. The complete 64x44 hit target is visibly painted: no
 * transparent padding, hover expansion, or host-specific alternate composer.
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
        "pointer-events-auto flex h-11 w-16 shrink-0 items-center justify-center rounded-full border border-white/20 bg-[#181a20]/95 p-0 text-white shadow-none backdrop-blur-xl",
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
