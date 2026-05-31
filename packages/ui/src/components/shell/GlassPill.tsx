import type * as React from "react";
import { useId } from "react";

import { cn } from "../../lib/utils";

/**
 * Small liquid-glass capsule for the home chat handle.
 *
 * This follows the CSS/SVG-filter stack used by recent macOS-style liquid glass
 * demos: a transparent wrapper, an SVG distortion backdrop layer, a tint, and
 * an inset shine. The parent button remains the large invisible hit target.
 */
export function GlassPill({
  className,
  testId,
}: {
  className?: string;
  testId?: string;
}): React.JSX.Element {
  const reactId = useId().replace(/:/g, "");
  const filterId = `home-liquid-glass-${reactId}`;

  return (
    <span
      data-testid={testId}
      className={cn(
        "relative isolate block overflow-hidden rounded-full",
        "shadow-[0_6px_16px_rgba(0,0,0,0.22),0_0_22px_rgba(255,255,255,0.12)]",
        className,
      )}
      aria-hidden
    >
      <svg
        aria-hidden
        className="pointer-events-none absolute h-0 w-0"
        focusable="false"
      >
        <filter
          id={filterId}
          x="-20%"
          y="-80%"
          width="140%"
          height="260%"
          colorInterpolationFilters="sRGB"
        >
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.018 0.12"
            numOctaves="2"
            seed="7"
            result="noise"
          />
          <feGaussianBlur in="noise" stdDeviation="1.2" result="softNoise" />
          <feDisplacementMap
            in="SourceGraphic"
            in2="softNoise"
            scale="18"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </svg>

      <span
        className="absolute inset-0 rounded-full backdrop-blur-[3px] backdrop-saturate-150"
        style={{
          backdropFilter: `url(#${filterId}) blur(3px) saturate(1.45) brightness(1.12)`,
          WebkitBackdropFilter: `url(#${filterId}) blur(3px) saturate(1.45) brightness(1.12)`,
        }}
      />
      <span className="absolute inset-0 rounded-full bg-white/24" />
      <span className="absolute inset-0 rounded-full shadow-[inset_2px_2px_1px_rgba(255,255,255,0.58),inset_-1px_-1px_1px_rgba(255,255,255,0.32),inset_0_-8px_16px_rgba(0,0,0,0.16)]" />
      <span className="absolute left-[18%] right-[18%] top-[26%] h-px rounded-full bg-white/70 blur-[0.2px]" />
    </span>
  );
}
