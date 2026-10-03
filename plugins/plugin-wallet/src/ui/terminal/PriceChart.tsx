/**
 * Interactive SVG line chart for one asset's live price history. Pointer and
 * arrow-key movement place a crosshair and read out the nearest observation;
 * the series itself is never resampled, so every point the route returned is
 * drawn. Colors come from theme tokens via `currentColor`.
 */
import { cn } from "@elizaos/ui/utils";
import * as React from "react";
import { useMemo, useState } from "react";
import type { WalletTerminalChartPoint } from "../../contracts.ts";
import { formatTerminalUsd } from "./format.ts";

void React;

const WIDTH = 720;
const HEIGHT = 240;
const PAD_Y = 16;

export function PriceChart({
  points,
  label,
}: {
  points: WalletTerminalChartPoint[];
  label: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const geometry = useMemo(() => {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) return null;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      min = Math.min(min, point.priceUsd);
      max = Math.max(max, point.priceUsd);
    }
    const span = max - min || 1;
    const timeSpan = last.t - first.t || 1;
    const xy = points.map((point) => [
      ((point.t - first.t) / timeSpan) * WIDTH,
      PAD_Y + (1 - (point.priceUsd - min) / span) * (HEIGHT - PAD_Y * 2),
    ]);
    const line = xy
      .map(
        ([x, y], index) =>
          `${index === 0 ? "M" : "L"}${x?.toFixed(1)},${y?.toFixed(1)}`,
      )
      .join(" ");
    return {
      xy,
      line,
      area: `${line} L${WIDTH},${HEIGHT} L0,${HEIGHT} Z`,
      last,
      rising: last.priceUsd >= first.priceUsd,
      min,
      max,
    };
  }, [points]);

  if (!geometry) return null;
  const active = hover === null ? null : points[hover];
  const activeXY = hover === null ? null : geometry.xy[hover];

  const nearestIndex = (clientX: number, rect: DOMRect) => {
    const x = ((clientX - rect.left) / rect.width) * WIDTH;
    let best = 0;
    for (let index = 1; index < geometry.xy.length; index += 1) {
      const candidate = geometry.xy[index]?.[0] ?? 0;
      const current = geometry.xy[best]?.[0] ?? 0;
      if (Math.abs(candidate - x) < Math.abs(current - x)) best = index;
    }
    return best;
  };

  return (
    <div className="relative">
      <div
        className="flex items-baseline justify-between gap-3 text-xs text-muted"
        aria-live="polite"
      >
        <span>
          {active
            ? new Date(active.t).toLocaleString(undefined, {
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              })
            : `Low ${formatTerminalUsd(geometry.min)} · High ${formatTerminalUsd(geometry.max)}`}
        </span>
        {active ? (
          <strong className="text-sm font-semibold text-txt">
            {formatTerminalUsd(active.priceUsd)}
          </strong>
        ) : null}
      </div>
      <div
        role="slider"
        aria-label={`${label} price chart, low ${formatTerminalUsd(geometry.min)}, high ${formatTerminalUsd(geometry.max)}`}
        aria-valuemin={0}
        aria-valuemax={points.length - 1}
        aria-valuenow={hover ?? points.length - 1}
        aria-valuetext={formatTerminalUsd((active ?? geometry.last).priceUsd)}
        tabIndex={0}
        data-testid="terminal-price-chart"
        className={cn(
          "mt-2 h-56 w-full touch-none rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent",
          geometry.rising ? "text-accent" : "text-danger",
        )}
        onPointerMove={(event) =>
          setHover(
            nearestIndex(
              event.clientX,
              event.currentTarget.getBoundingClientRect(),
            ),
          )
        }
        onPointerLeave={() => setHover(null)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const step = event.key === "ArrowLeft" ? -1 : 1;
          setHover((current) =>
            Math.min(
              points.length - 1,
              Math.max(0, (current ?? (step > 0 ? -1 : points.length)) + step),
            ),
          );
        }}
        onBlur={() => setHover(null)}
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
          className="size-full"
        >
          <path d={geometry.area} fill="currentColor" opacity={0.08} />
          <path
            d={geometry.line}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
          {activeXY ? (
            <g className="text-muted">
              <line
                x1={activeXY[0]}
                x2={activeXY[0]}
                y1={0}
                y2={HEIGHT}
                stroke="currentColor"
                strokeDasharray="4 4"
                vectorEffect="non-scaling-stroke"
              />
            </g>
          ) : null}
        </svg>
      </div>
    </div>
  );
}
