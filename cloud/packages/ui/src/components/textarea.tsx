/**
 * Textarea component with auto-sizing and consistent styling.
 * Supports validation states and accessibility attributes.
 */
import * as React from "react";

import { cn } from "../lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full !rounded-none border border-white/10 bg-black/40 px-3 py-2 text-base text-white placeholder:text-white/35 shadow-none transition-[color,box-shadow,border-color,background-color] outline-none focus-visible:border-[#FF5800]/50 focus-visible:bg-black/55 focus-visible:ring-2 focus-visible:ring-[#FF5800]/25 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
