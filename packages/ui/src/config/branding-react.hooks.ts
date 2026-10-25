/**
 * React-bound branding context object + hook. Split from the non-React
 * `branding-base` surface so Node-side consumers can import branding values
 * without pulling `react` into their runtime closure.
 */
import { createContext, useContext } from "react";
import type { BrandingConfig } from "./branding-base.ts";
import { DEFAULT_BRANDING } from "./branding-base.ts";

export const BrandingContext = createContext<BrandingConfig | undefined>(
  undefined,
);

export function useBranding(): BrandingConfig {
  return useContext(BrandingContext) ?? DEFAULT_BRANDING;
}
