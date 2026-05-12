/**
 * React-bound branding context. Split from `branding.ts` so that node-side
 * consumers (bench server, agent boot) can import the type-only and helper
 * exports from `@elizaos/shared` without pulling React into the runtime.
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
