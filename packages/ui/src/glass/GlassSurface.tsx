/**
 * The one glass primitive every glassmorphic chrome element renders through:
 * `<GlassSurface variant="menu">…</GlassSurface>`. Picks the variant recipe
 * from `tokens.ts`, paints it at the best tier `useNativeGlass` reports, and
 * keeps the branded edge (rim ring + sheen + inset edge shadow) identical on
 * every tier — the tier only decides what produces the MATERIAL:
 *
 *   css tiers      — translucent fill + backdrop-filter on this element
 *                    (refraction upgrade on Chromium via `@supports`).
 *   native   — the element goes transparent and a real UIGlassEffect
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
.eliza-glass-${variant}[data-glass-tier="native"] {
  background-color: transparent;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}`;
    const refraction = r.refraction
      ? `
@supports (backdrop-filter: url(#x)) {
  .eliza-glass-${variant}:not([data-glass-tier="native"]) {
    backdrop-filter: ${r.refraction};
    -webkit-backdrop-filter: ${r.refraction};
  }
}`
      : "";
    const rim = r.rim ? liquidGlassRimCss(`.eliza-glass-${variant}`) : "";
    return base + refraction + rim;
  }).join("\n");
  // Opt-in rim for surfaces that carry their own material (e.g. the chat
  // sheet, whose fill/blur ride motion values): the same directional ring,
  // keyed by attribute so it can follow a morph without a class swap.
  const attrRim = liquidGlassRimCss('[data-glass-rim="on"]');
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: build-time constant CSS from tokens — no user input reaches it */}
      <style dangerouslySetInnerHTML={{ __html: css + attrRim }} />
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

/**
 * Anchor/unanchor the native material to this element's rect. Exported so
 * surfaces that cannot render through `GlassSurface` (the chat sheet, whose
 * fill and radius ride motion values) can still get the real OS material at
 * the native tier: pass `enabled` = tier is native AND the surface is in a
 * state where glass applies (e.g. inset, not full-bleed). Rect sync is
 * rAF-coalesced so a drag that resizes the element per frame issues at most
 * one bridge call per frame.
 */
export function useNativeGlassAnchor(
  ref: React.RefObject<HTMLDivElement | null>,
  enabled: boolean,
  interactive = false,
): void {
  const regionId = useId();
  useEffect(() => {
    if (!enabled) return;
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
    let raf = 0;
    const sync = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        void bridge.updateRect({ id: regionId, rect: rectOf() });
      });
    };
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    window.addEventListener("resize", sync);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("resize", sync);
      void bridge.detachGlass({ id: regionId });
    };
  }, [enabled, interactive, ref, regionId]);
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
  useNativeGlassAnchor(ref, tier === "native", interactive);
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
