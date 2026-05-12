/**
 * React-bound branding context. Imports the non-React base surface directly
 * so this file does not form a cycle with the compatibility barrel.
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
