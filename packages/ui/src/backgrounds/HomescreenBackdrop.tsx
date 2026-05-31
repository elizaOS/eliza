import type { CSSProperties, ReactNode } from "react";
import { HomescreenCanvas } from "../homescreen/HomescreenCanvas";
import { createDefaultScene } from "../homescreen/scene-types";

export interface HomescreenBackdropProps {
  /** Foreground content rendered above the canvas. */
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

// The default scene is stable for the lifetime of the backdrop — build it once
// so the canvas never remounts from an identity change.
const DEFAULT_SCENE = createDefaultScene();

/**
 * Full-bleed homescreen backdrop for surfaces that want the brand's living
 * crystal ball without any edit chrome — onboarding, login, and other
 * pre-agent screens.
 *
 * Renders the default fresnel-crystal-ball scene (white sphere over brand
 * orange) behind its children. The wrapper is painted brand orange so the
 * surface is on-brand even before WebGL initializes or when it is unavailable
 * (jsdom, SSR) — the canvas simply layers the 3D sphere on top once it can.
 * Under prefers-reduced-motion the sphere renders as a single static frame
 * rather than animating.
 */
export function HomescreenBackdrop({
  children,
  className,
  style,
}: HomescreenBackdropProps) {
  return (
    <div
      className={className}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        background: "var(--brand-orange, #ff5800)",
        ...style,
      }}
    >
      <HomescreenCanvas scene={DEFAULT_SCENE} phase="idle" />
      <div
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          height: "100%",
          minHeight: "inherit",
        }}
      >
        {children}
      </div>
    </div>
  );
}
