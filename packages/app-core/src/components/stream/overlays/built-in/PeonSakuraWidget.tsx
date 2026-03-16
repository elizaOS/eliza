/**
 * Peon Sakura Widget — Zen garden ambient overlay with cherry blossom petals.
 *
 * Renders animated falling petals and a minimal status indicator.
 * Petal activity scales with event density — more events = more petals.
 * Inspired by the peon-ping "sakura" theme.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { registerWidget } from "../registry";
import type { WidgetDefinition, WidgetRenderProps } from "../types";

// ---------------------------------------------------------------------------
// Petal simulation
// ---------------------------------------------------------------------------

interface Petal {
  x: number;
  y: number;
  size: number;
  rotation: number;
  rotSpeed: number;
  fallSpeed: number;
  swayAmplitude: number;
  swayOffset: number;
  opacity: number;
  hue: number;
}

function createPetal(canvasW: number): Petal {
  return {
    x: Math.random() * canvasW,
    y: -10 - Math.random() * 40,
    size: 4 + Math.random() * 6,
    rotation: Math.random() * Math.PI * 2,
    rotSpeed: (Math.random() - 0.5) * 0.04,
    fallSpeed: 0.3 + Math.random() * 0.5,
    swayAmplitude: 15 + Math.random() * 25,
    swayOffset: Math.random() * Math.PI * 2,
    opacity: 0.3 + Math.random() * 0.5,
    hue: 330 + Math.random() * 30, // pink range
  };
}

function drawPetal(ctx: CanvasRenderingContext2D, p: Petal, time: number) {
  const sx = p.x + Math.sin(time * 0.001 + p.swayOffset) * p.swayAmplitude;
  ctx.save();
  ctx.translate(sx, p.y);
  ctx.rotate(p.rotation);
  ctx.globalAlpha = p.opacity;

  // Draw a simple petal shape
  ctx.fillStyle = `hsl(${p.hue}, 80%, 78%)`;
  ctx.beginPath();
  ctx.ellipse(0, 0, p.size, p.size * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();

  // Inner highlight
  ctx.fillStyle = `hsl(${p.hue}, 90%, 88%)`;
  ctx.beginPath();
  ctx.ellipse(0, 0, p.size * 0.5, p.size * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function PeonSakura({ instance, events, agentMode }: WidgetRenderProps) {
  const petalDensity = (instance.config.petalDensity as number) ?? 12;
  const showStatus = (instance.config.showStatus as boolean) ?? true;
  const accentColor = (instance.config.accentColor as string) ?? "#f9a8d4";

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const petalsRef = useRef<Petal[]>([]);
  const rafRef = useRef(0);

  // Scale petal count with event density
  const recentCount = useMemo(() => {
    const cutoff = Date.now() - 15_000;
    return events.filter((e) => e.ts > cutoff).length;
  }, [events]);

  const targetPetalCount = Math.min(
    petalDensity + Math.floor(recentCount * 1.5),
    petalDensity * 3,
  );

  // Latest event text for subtle status line
  const latestText = useMemo(() => {
    if (events.length === 0) return "";
    const p = events[events.length - 1].payload as Record<string, unknown>;
    const t =
      typeof p.text === "string"
        ? p.text
        : typeof p.preview === "string"
          ? p.preview
          : "";
    return t.length > 50 ? `${t.slice(0, 50)}...` : t;
  }, [events]);

  const [canvasSize, setCanvasSize] = useState({ w: 300, h: 300 });

  // Resize observer
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas?.parentElement) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setCanvasSize({ w: Math.round(width), h: Math.round(height) });
        }
      }
    });
    ro.observe(canvas.parentElement);
    return () => ro.disconnect();
  }, []);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;

    const tick = () => {
      if (!running) return;
      const now = performance.now();
      const { w, h } = canvasSize;
      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);

      // Spawn new petals
      while (petalsRef.current.length < targetPetalCount) {
        petalsRef.current.push(createPetal(w));
      }
      // Remove excess
      if (petalsRef.current.length > targetPetalCount + 5) {
        petalsRef.current.splice(targetPetalCount);
      }

      // Update & draw
      const live: Petal[] = [];
      for (const p of petalsRef.current) {
        p.y += p.fallSpeed;
        p.rotation += p.rotSpeed;

        if (p.y < h + 20) {
          drawPetal(ctx, p, now);
          live.push(p);
        } else {
          // Recycle at top
          live.push(createPetal(w));
        }
      }
      petalsRef.current = live;

      rafRef.current = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [canvasSize, targetPetalCount]);

  const modeEmoji = useMemo(() => {
    switch (agentMode) {
      case "gaming":
        return "\u{1F3AE}";
      case "terminal":
        return "\u{1F4BB}";
      case "chatting":
        return "\u{1F4AC}";
      default:
        return "\u{1F338}";
    }
  }, [agentMode]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />

      {showStatus && latestText && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 8,
            right: 8,
            background: "rgba(10, 5, 15, 0.5)",
            backdropFilter: "blur(8px)",
            WebkitBackdropFilter: "blur(8px)",
            borderRadius: 8,
            padding: "6px 10px",
            fontFamily: "'Inter', system-ui, sans-serif",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ fontSize: 12 }}>{modeEmoji}</span>
          <span
            style={{
              fontSize: 10,
              color: accentColor,
              opacity: 0.85,
              lineHeight: 1.3,
            }}
          >
            {latestText}
          </span>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget definition + registration
// ---------------------------------------------------------------------------

const definition: WidgetDefinition = {
  type: "peon-sakura",
  name: "Peon Sakura",
  description:
    "Zen garden ambient overlay with animated cherry blossom petals that scale with activity",
  subscribesTo: ["thought", "action", "tool", "assistant", "evaluator"],
  defaultPosition: { x: 0, y: 0, width: 25, height: 50 },
  defaultZIndex: 3,
  configSchema: {
    petalDensity: {
      type: "number",
      label: "Base petal count",
      default: 12,
      min: 4,
      max: 40,
    },
    showStatus: {
      type: "boolean",
      label: "Show status bar",
      default: true,
    },
    accentColor: {
      type: "color",
      label: "Text color",
      default: "#f9a8d4",
    },
  },
  defaultConfig: { petalDensity: 12, showStatus: true, accentColor: "#f9a8d4" },
  render: PeonSakura,
};

registerWidget(definition);
export default definition;
