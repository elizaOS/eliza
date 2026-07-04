/**
 * cn(): the tailwind-merge + clsx class combiner. Browser-safe; prefer this over
 * the utils barrel when bundling the kit (see package CLAUDE.md).
 */
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
