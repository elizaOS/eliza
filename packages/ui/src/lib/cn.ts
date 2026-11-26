import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import tokens from "@repo/design-system/tokens.json" with { type: "json" };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const cnFor = (groups: Record<string, unknown>) => {
  const names = (group: string) => Object.keys(groups[group] ?? {});
  const nested = (group: string, key: string) => {
    const inner = groups[group];
    const value = isRecord(inner) ? inner[key] : undefined;
    return isRecord(value) ? Object.keys(value) : [];
  };
  const twMerge = extendTailwindMerge({
    extend: {
      theme: {
        text: names("text"), radius: names("rounded"), shadow: names("shadow"), blur: names("blur"), animate: names("animate"),
        "font-weight": names("weight"), leading: names("leading"), tracking: names("tracking"), ease: nested("motion", "ease"),
      },
      classGroups: { z: [{ z: names("z") }], duration: [{ duration: nested("motion", "duration") }] },
    },
  });
  return (...inputs: ClassValue[]) => twMerge(clsx(inputs));
};

export const cn = cnFor(tokens);

export const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-ring";
