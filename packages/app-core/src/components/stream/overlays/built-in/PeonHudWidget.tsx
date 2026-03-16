/**
 * Peon HUD Widget — Jarvis-inspired circular heads-up display.
 *
 * Renders a rotating arc HUD showing agent status, current mode,
 * and recent activity count. Inspired by the peon-ping "jarvis" theme.
 */

import { useApp } from "@elizaos/app-core/state";
import { useEffect, useMemo, useRef } from "react";
import { registerWidget } from "../registry";
import type { WidgetDefinition, WidgetRenderProps } from "../types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Canvas-based HUD renderer
// ---------------------------------------------------------------------------

function drawHud(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rotation: number,
  progress: number,
  accentColor: string,
  dimColor: string,
) {
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 4;

  // Outer rotating arc
  ctx.strokeStyle = accentColor;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, rotation, rotation + TAU * 0.7);
  ctx.stroke();

  // Inner counter-rotating arc
  ctx.strokeStyle = dimColor;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.78, -rotation * 1.3, -rotation * 1.3 + TAU * 0.5);
  ctx.stroke();

  // Graduation ticks (12 positions)
  for (let i = 0; i < 12; i++) {
    const angle = (TAU / 12) * i + rotation * 0.2;
    const inner = r * 0.85;
    const outer = r * 0.92;
    ctx.strokeStyle = i % 3 === 0 ? accentColor : dimColor;
    ctx.lineWidth = i % 3 === 0 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner);
    ctx.lineTo(cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer);
    ctx.stroke();
  }

  // Progress ring (inner)
  if (progress > 0) {
    ctx.strokeStyle = accentColor;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(
      cx,
      cy,
      r * 0.65,
      -Math.PI / 2,
      -Math.PI / 2 + TAU * Math.min(progress, 1),
    );
    ctx.stroke();
    ctx.lineCap = "butt";
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function PeonHud({
  instance,
  events,
  agentMode,
  agentName,
}: WidgetRenderProps) {
  const { t } = useApp();
  const accentColor = (instance.config.accentColor as string) ?? "#00e5ff";
  const showLabel = (instance.config.showLabel as boolean) ?? true;
  const showEventCount = (instance.config.showEventCount as boolean) ?? true;

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rotationRef = useRef(0);
  const rafRef = useRef(0);

  // Derive a pseudo-progress from recent event density
  const recentCount = useMemo(() => {
    const cutoff = Date.now() - 30_000;
    return events.filter((e) => e.ts > cutoff).length;
  }, [events]);

  const progress = Math.min(recentCount / 20, 1);

  const modeLabel = useMemo(() => {
    switch (agentMode) {
      case "gaming":
        return "GAMING";
      case "terminal":
        return "EXECUTING";
      case "chatting":
        return "CHATTING";
      default:
        return "STANDBY";
    }
  }, [agentMode]);

  // Animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dim = `${accentColor}44`;
    let running = true;

    const tick = () => {
      if (!running) return;
      rotationRef.current += 0.008;
      drawHud(
        ctx,
        canvas.width,
        canvas.height,
        rotationRef.current,
        progress,
        accentColor,
        dim,
      );
      rafRef.current = requestAnimationFrame(tick);
    };
    tick();

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [accentColor, progress]);

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
        color: accentColor,
      }}
    >
      <canvas
        ref={canvasRef}
        width={140}
        height={140}
        style={{ width: 140, height: 140 }}
      />

      {showLabel && (
        <div
          style={{
            marginTop: 6,
            fontSize: 10,
            letterSpacing: "0.15em",
            textTransform: "uppercase",
            opacity: 0.9,
            textAlign: "center",
          }}
        >
          <div style={{ fontWeight: 600 }}>{modeLabel}</div>
          <div style={{ opacity: 0.6, fontSize: 9, marginTop: 2 }}>
            {agentName}
          </div>
        </div>
      )}

      {showEventCount && (
        <div
          style={{
            marginTop: 4,
            fontSize: 9,
            opacity: 0.5,
            letterSpacing: "0.1em",
          }}
        >
          {events.length} {t("peonhudwidget.events")}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget definition + registration
// ---------------------------------------------------------------------------

const definition: WidgetDefinition = {
  type: "peon-hud",
  name: "Peon HUD",
  description:
    "Jarvis-inspired circular heads-up display showing agent mode and activity",
  subscribesTo: ["thought", "action", "tool", "assistant", "evaluator"],
  defaultPosition: { x: 82, y: 10, width: 16, height: 30 },
  defaultZIndex: 12,
  configSchema: {
    accentColor: {
      type: "color",
      label: "Accent color",
      default: "#00e5ff",
    },
    showLabel: {
      type: "boolean",
      label: "Show mode label",
      default: true,
    },
    showEventCount: {
      type: "boolean",
      label: "Show event count",
      default: true,
    },
  },
  defaultConfig: {
    accentColor: "#00e5ff",
    showLabel: true,
    showEventCount: true,
  },
  render: PeonHud,
};

registerWidget(definition);
export default definition;
