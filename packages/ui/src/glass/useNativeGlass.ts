/**
 * Glass-tier capability probe. Every glass surface renders through one of
 * three tiers, best-available-first, and the tier NEVER changes a surface's
 * geometry — only which layer paints the material:
 *
 *   'native'         — real native material behind the element via the
 *                      GlassBridge plugin: UIGlassEffect on Capacitor iOS 26+,
 *                      the Material dynamic-palette panel on Android 12+. The
 *                      element keeps only the rim/sheen overlays; the fill
 *                      comes from the OS.
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

export type GlassTier = "native" | "css-refraction" | "css-frosted";

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
      if (alive && available) setTier("native");
    });
    return () => {
      alive = false;
    };
  }, []);
  return tier;
}
