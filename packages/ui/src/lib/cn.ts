import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import tokens from "@repo/design-system/tokens.json" with { type: "json" };

// The token groups that name utilities (vibestack/design/generate.ts), so a later `text-body` replaces a
// size and not a color. Each group is optional in tokens.json.
const groups: Record<string, unknown> = tokens;
const names = (group: string) => Object.keys(groups[group] ?? {});
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: names("text"), radius: names("rounded"), shadow: names("shadow"), blur: names("blur"), animate: names("animate"),
      "font-weight": names("weight"), leading: names("leading"), tracking: names("tracking"),
    },
    classGroups: { z: [{ z: names("z") }] },
  },
});

/** Joins class names; a later Tailwind utility replaces an earlier one it conflicts with. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/** The ring every control shows under keyboard focus. */
export const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-ring";
