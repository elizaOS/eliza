import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as React from "react";

import { cn } from "../../lib/utils";

const TooltipProvider: typeof TooltipPrimitive.Provider =
  TooltipPrimitive.Provider;

const Tooltip: typeof TooltipPrimitive.Root = TooltipPrimitive.Root;

const TooltipTrigger: typeof TooltipPrimitive.Trigger =
  TooltipPrimitive.Trigger;

type TooltipContentElement = React.ElementRef<typeof TooltipPrimitive.Content>;
type TooltipContentProps = React.ComponentPropsWithoutRef<
  typeof TooltipPrimitive.Content
>;

const TooltipContent: React.ForwardRefExoticComponent<
  React.PropsWithoutRef<TooltipContentProps> &
    React.RefAttributes<TooltipContentElement>
> = React.forwardRef<TooltipContentElement, TooltipContentProps>(
  ({ className, sideOffset = 4, ...props }, ref) => (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-[140] overflow-hidden rounded-sm border border-border bg-card px-3 py-1.5 text-sm text-txt shadow-sm max-w-[min(24rem,calc(100vw_-_2rem))] animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2",
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Portal>
  ),
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export interface TooltipHintProps {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: React.ComponentPropsWithoutRef<
    typeof TooltipPrimitive.Content
  >["side"];
  sideOffset?: number;
  contentClassName?: string;
  delayDuration?: number;
  skipDelayDuration?: number;
}

export function TooltipHint({
  children,
  content,
  side = "bottom",
  sideOffset = 4,
  contentClassName,
  delayDuration = 200,
  skipDelayDuration = 100,
}: TooltipHintProps) {
  return (
    <TooltipProvider
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
    >
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent
          side={side}
          sideOffset={sideOffset}
          className={contentClassName}
        >
          {content}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
