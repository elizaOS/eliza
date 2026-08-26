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
 * The default surface is the compact 48x6 embedded mark. A detached macOS
 * caller supplies its exact 64x12 host dimensions so visible material and
 * native hit geometry remain identical, with no dark capsule or clear halo.
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
            "pointer-events-none h-full w-full rounded-full bg-white/95 opacity-100",
            breathing && "eliza-chat-handle-breathe",
            markClassName,
          )}
          style={{ backgroundColor: "rgba(255, 255, 255, 0.96)" }}
        />
      )}
    </Button>
  );
}
