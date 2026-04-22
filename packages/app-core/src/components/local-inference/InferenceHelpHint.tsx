import { Tooltip, TooltipContent, TooltipTrigger } from "@elizaos/ui";
import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";

/** Small “?” control with rich tooltip — pair with an ancestor `TooltipProvider`. */
export function InferenceHelpHint({
  "aria-label": ariaLabel,
  children,
}: {
  "aria-label": string;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={ariaLabel}
        >
          <CircleHelp className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        className="max-w-[min(22rem,calc(100vw-2rem))] space-y-2 p-3 text-left text-xs leading-relaxed text-txt"
      >
        {children}
      </TooltipContent>
    </Tooltip>
  );
}
