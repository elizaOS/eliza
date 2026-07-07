/**
 * The one glass primitive every glassmorphic chrome element renders through:
 * `<GlassSurface variant="menu">…</GlassSurface>`. Picks the variant recipe
 * from `tokens.ts`, paints it at the best tier `useNativeGlass` reports, and
 * keeps the branded edge (rim ring + sheen + inset edge shadow) identical on
 * every tier — the tier only decides what produces the MATERIAL:
 *
 *   css tiers      — translucent fill + backdrop-filter on this element
 *                    (refraction upgrade on Chromium via `@supports`).
 *   ios26-native   — the element goes transparent and a real UIGlassEffect
 *                    view is anchored to its rect through the GlassBridge
 *                    plugin. Rect syncs on mount and on resize (ResizeObserver
 *                    + window resize) — NOT per scroll frame, which is why the
 *                    primitive is for stable chrome (sheets at rest, pills,
 *                    menus, headers), never for elements inside a scroller.
 *
 * `GlassStyles` mounts the shared stylesheet (rim pseudo-element + the
 * Chromium refraction upgrade) once per document, alongside
 * `LiquidGlassRefractionDefs`; the app shell renders it a single time.
 */

import type * as React from "react";
import { useEffect, useId, useRef } from "react";
import {
  LiquidGlassRefractionDefs,
  liquidGlassRimCss,
} from "../components/shell/liquid-glass";
import { glassBridge } from "./native-bridge";
import { GLASS_RECIPES, type GlassVariant } from "./tokens";
import { type GlassTier, useNativeGlass } from "./useNativeGlass";

const VARIANTS = Object.keys(GLASS_RECIPES) as GlassVariant[];

/** Shared stylesheet: per-variant class + rim + Chromium refraction upgrade. */
export function GlassStyles(): React.JSX.Element {
  const css = VARIANTS.map((variant) => {
    const r = GLASS_RECIPES[variant];
    const base = `
.eliza-glass-${variant} {
  position: relative;
  background-color: ${r.background};
  background-image: ${r.sheen};
  box-shadow: ${r.edgeShadow};
  backdrop-filter: ${r.backdropFilter};
  -webkit-backdrop-filter: ${r.backdropFilter};
  border-radius: ${r.radius};
}
.eliza-glass-${variant}[data-glass-tier="ios26-native"] {
  background-color: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}`;
    const refraction = r.refraction
      ? `
@supports (backdrop-filter: url(#x)) {
  .eliza-glass-${variant}:not([data-glass-tier="ios26-native"]) {
    backdrop-filter: ${r.refraction};
    -webkit-backdrop-filter: ${r.refraction};
  }
}`
      : "";
    const rim = r.rim ? liquidGlassRimCss(`.eliza-glass-${variant}`) : "";
    return base + refraction + rim;
  }).join("\n");
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: build-time constant CSS from tokens — no user input reaches it */}
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <LiquidGlassRefractionDefs />
    </>
  );
}

export interface GlassSurfaceProps
  extends React.HTMLAttributes<HTMLDivElement> {
  variant: GlassVariant;
  /**
   * Forwarded to the native tier's UIGlassEffect (touch grow/shimmer).
   * Mount-time only — the system cannot toggle it on a live effect view.
   */
  interactive?: boolean;
}

/** Anchor/unanchor the native material to this element's rect. */
function useNativeAnchor(
  ref: React.RefObject<HTMLDivElement | null>,
  tier: GlassTier,
  interactive: boolean,
): void {
  const regionId = useId();
  useEffect(() => {
    if (tier !== "ios26-native") return;
    const el = ref.current;
    const bridge = glassBridge();
    if (!el || !bridge) return;
    const radius = Number.parseFloat(getComputedStyle(el).borderRadius) || 12;
    const rectOf = () => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    void bridge.attachGlass({
      id: regionId,
      rect: rectOf(),
      cornerRadius: radius,
      interactive,
    });
    const sync = () => void bridge.updateRect({ id: regionId, rect: rectOf() });
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      void bridge.detachGlass({ id: regionId });
    };
  }, [tier, interactive, ref, regionId]);
}

export function GlassSurface({
  variant,
  interactive = false,
  className,
  children,
  ...rest
}: GlassSurfaceProps): React.JSX.Element {
  const tier = useNativeGlass();
  const ref = useRef<HTMLDivElement>(null);
  useNativeAnchor(ref, tier, interactive);
  return (
    <div
      {...rest}
      ref={ref}
      data-glass-tier={tier}
      className={
        className
          ? `eliza-glass-${variant} ${className}`
          : `eliza-glass-${variant}`
      }
    >
      {children}
    </div>
  );
}
