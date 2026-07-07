/**
 * Glass-tier capability probe. Every glass surface renders through one of
 * three tiers, best-available-first, and the tier NEVER changes a surface's
 * geometry — only which layer paints the material:
 *
 *   'ios26-native'   — real UIGlassEffect behind the element (Capacitor iOS 26+
 *                      with the GlassBridge plugin). The element keeps only the
 *                      rim/sheen overlays; fill + blur come from the OS.
 *   'css-refraction' — Chromium: SVG feDisplacementMap edge refraction
 *                      (`backdrop-filter: url(#…)`), the branded CSS pinnacle.
 *   'css-frosted'    — universal fallback: plain blur+saturate backdrop.
 *
 * The hook resolves synchronously to a CSS tier and upgrades to native when
 * the async availability probe answers — surfaces paint immediately and the
 * native material slides in underneath, so there is no unstyled flash and no
 * layout shift on any tier.
 */

import { useEffect, useState } from "react";
import { isNativeGlassAvailable } from "./native-bridge";

export type GlassTier = "ios26-native" | "css-refraction" | "css-frosted";

function cssTier(): GlassTier {
  if (
    typeof CSS !== "undefined" &&
    CSS.supports?.("backdrop-filter", "url(#x)")
  ) {
    return "css-refraction";
  }
  return "css-frosted";
}

export function useNativeGlass(): GlassTier {
  const [tier, setTier] = useState<GlassTier>(cssTier);
  useEffect(() => {
    let alive = true;
    void isNativeGlassAvailable().then((available) => {
      if (alive && available) setTier("ios26-native");
    });
    return () => {
      alive = false;
    };
  }, []);
  return tier;
}
