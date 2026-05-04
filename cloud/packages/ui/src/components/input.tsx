/**
 * Input component with consistent styling and focus states.
 * Supports file inputs, validation states, and accessibility attributes.
 */
import * as React from "react";

import { cn } from "../lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-white placeholder:text-white/35 selection:bg-[#FF5800] selection:text-white !rounded-none border-white/10 bg-black/40 text-white h-10 w-full min-w-0 border px-3 py-2 text-base shadow-none transition-[color,box-shadow,border-color,background-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-[#FF5800]/50 focus-visible:bg-black/55 focus-visible:ring-2 focus-visible:ring-[#FF5800]/25",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
