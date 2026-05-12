import type { CSSProperties } from "react";
import { cn } from "../../lib/utils";

const NODE_COUNT = 18;
const HELIX_HEIGHT = 104;
const HELIX_RADIUS = 26;
const RING_RADIUS = 45;
const RING_INNER_RADIUS = 31;
const DNA_NODE_IDS = Array.from(
  { length: NODE_COUNT },
  (_, index) => `dna-loader-pair-${index}`,
);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mix(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

function pointStyle(x: number, y: number): CSSProperties {
  return {
    left: `calc(50% + ${x.toFixed(2)}px)`,
    top: `calc(50% + ${y.toFixed(2)}px)`,
  };
}

interface DnaLoaderProps {
  className?: string;
  progress?: number;
  size?: number;
}

export function DnaLoader({
  className,
  progress = 0,
  size = 124,
}: DnaLoaderProps) {
  const morph = clamp((progress - 68) / 32, 0, 1);

  return (
    <div
      aria-hidden="true"
      className={cn("dna-loader", className)}
      data-complete={progress >= 100 ? "true" : "false"}
      style={{ "--dna-loader-size": `${size}px` } as CSSProperties}
    >
      {DNA_NODE_IDS.map((nodeId, index) => {
        const t = index / (NODE_COUNT - 1);
        const helixY = mix(-HELIX_HEIGHT / 2, HELIX_HEIGHT / 2, t);
        const helixAngle = t * Math.PI * 5.35;
        const ringAngle = t * Math.PI * 2 - Math.PI / 2;

        const helixXOuter = Math.sin(helixAngle) * HELIX_RADIUS;
        const helixXInner = Math.sin(helixAngle + Math.PI) * HELIX_RADIUS;
        const ringOuterX = Math.cos(ringAngle) * RING_RADIUS;
        const ringOuterY = Math.sin(ringAngle) * RING_RADIUS;
        const ringInnerX = Math.cos(ringAngle) * RING_INNER_RADIUS;
        const ringInnerY = Math.sin(ringAngle) * RING_INNER_RADIUS;

        const x1 = mix(helixXOuter, ringOuterX, morph);
        const y1 = mix(helixY, ringOuterY, morph);
        const x2 = mix(helixXInner, ringInnerX, morph);
        const y2 = mix(helixY, ringInnerY, morph);
        const dx = x2 - x1;
        const dy = y2 - y1;
        const length = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        const opacity = 0.36 + Math.sin(helixAngle) * 0.18;

        return (
          <div className="dna-loader__pair" key={nodeId}>
            <span
              className="dna-loader__bar"
              style={{
                ...pointStyle(x1, y1),
                width: `${length.toFixed(2)}px`,
                transform: `rotate(${angle}rad)`,
                opacity,
              }}
            />
            <span className="dna-loader__dot" style={pointStyle(x1, y1)} />
            <span className="dna-loader__dot" style={pointStyle(x2, y2)} />
          </div>
        );
      })}
    </div>
  );
}
