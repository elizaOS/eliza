import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Joins class names; a later Tailwind utility replaces an earlier one it conflicts with. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

/** The ring every control shows under keyboard focus. */
export const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-ring";
