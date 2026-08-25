/**
 * cn(): the tailwind-merge + clsx class combiner. Browser-safe; prefer this over
 * the utils barrel when bundling the kit (see package CLAUDE.md).
 *
 * The merge config must know the project's custom font-size utilities
 * (tailwind-theme.css `--text-*`). Without registration tailwind-merge parses
 * `text-xs-tight` as a text *color* and silently drops it when a real color
 * class follows in the same cn() call.
 */
import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "3xs",
            "2xs",
            "xs-tight",
            "sm-tight",
            "chat-body",
            "chat-lead",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
