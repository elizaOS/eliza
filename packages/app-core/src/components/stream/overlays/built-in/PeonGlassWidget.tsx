/**
 * Peon Glass Widget — Glassmorphism notification panel.
 *
 * Renders agent events as a translucent glass-style notification card with
 * an accent color bar and animated progress line. Inspired by the peon-ping
 * "glass" theme.
 */

import { useEffect, useMemo, useState } from "react";
import { registerWidget } from "../registry";
import type { WidgetDefinition, WidgetRenderProps } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEventText(e: { payload: object }): string {
  const p = e.payload as Record<string, unknown>;
  if (typeof p.text === "string" && p.text) return p.text;
  if (typeof p.preview === "string" && p.preview) return p.preview;
  if (typeof p.reason === "string" && p.reason) return p.reason;
  return "";
}

function getEventSource(e: { payload: object; stream?: string }): string {
  const p = e.payload as Record<string, unknown>;
  if (typeof p.source === "string" && p.source) return p.source;
  if (typeof p.channel === "string" && p.channel) return p.channel;
  return e.stream ?? "agent";
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

function PeonGlass({ instance, events }: WidgetRenderProps) {
  const accentColor = (instance.config.accentColor as string) ?? "#a78bfa";
  const maxItems = (instance.config.maxItems as number) ?? 4;
  const displayMs = (instance.config.displayDuration as number) ?? 6000;

  const [visibleItems, setVisibleItems] = useState<
    Array<{
      id: string;
      source: string;
      text: string;
      ts: number;
      fading: boolean;
    }>
  >([]);

  // Track new events and display them with fade timers
  const latestId = useMemo(() => {
    if (events.length === 0) return null;
    return events[events.length - 1].eventId;
  }, [events]);

  useEffect(() => {
    if (!latestId || events.length === 0) return;
    const e = events[events.length - 1];
    const text = getEventText(e);
    if (!text) return;

    const item = {
      id: e.eventId,
      source: getEventSource(e),
      text: text.length > 120 ? `${text.slice(0, 120)}...` : text,
      ts: e.ts,
      fading: false,
    };

    setVisibleItems((prev) => {
      const next = [...prev.filter((i) => i.id !== item.id), item];
      return next.slice(-maxItems);
    });

    // Start fade
    const fadeTimer = setTimeout(() => {
      setVisibleItems((prev) =>
        prev.map((i) => (i.id === item.id ? { ...i, fading: true } : i)),
      );
    }, displayMs - 800);

    // Remove
    const removeTimer = setTimeout(() => {
      setVisibleItems((prev) => prev.filter((i) => i.id !== item.id));
    }, displayMs);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(removeTimer);
    };
  }, [latestId, events, maxItems, displayMs]);

  if (visibleItems.length === 0) return null;

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontFamily: "'Inter', 'SF Pro', system-ui, sans-serif",
        overflow: "hidden",
      }}
    >
      {visibleItems.map((item) => (
        <div
          key={item.id}
          style={{
            background: "rgba(15, 15, 25, 0.65)",
            backdropFilter: "blur(16px) saturate(1.4)",
            WebkitBackdropFilter: "blur(16px) saturate(1.4)",
            borderRadius: 10,
            border: "1px solid rgba(255, 255, 255, 0.08)",
            overflow: "hidden",
            opacity: item.fading ? 0 : 1,
            transform: item.fading ? "translateY(-4px)" : "translateY(0)",
            transition: "opacity 0.6s ease, transform 0.6s ease",
          }}
        >
          {/* Accent color bar */}
          <div
            style={{
              height: 3,
              background: `linear-gradient(90deg, ${accentColor}, ${accentColor}88)`,
            }}
          />

          <div style={{ padding: "8px 12px" }}>
            {/* Header: source + timestamp */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 4,
              }}
            >
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: accentColor,
                }}
              >
                {item.source}
              </span>
              <span
                style={{
                  fontSize: 8,
                  color: "rgba(255, 255, 255, 0.35)",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {formatTime(item.ts)}
              </span>
            </div>

            {/* Body text */}
            <p
              style={{
                margin: 0,
                fontSize: 11,
                lineHeight: 1.45,
                color: "rgba(255, 255, 255, 0.85)",
              }}
            >
              {item.text}
            </p>
          </div>

          {/* Animated progress line */}
          <div
            style={{
              height: 2,
              background: `${accentColor}22`,
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                height: "100%",
                width: "100%",
                background: `linear-gradient(90deg, transparent, ${accentColor}66, transparent)`,
                animation: "peon-glass-sweep 2s ease-in-out infinite",
              }}
            />
          </div>
        </div>
      ))}

      {/* Keyframe injection */}
      <style>
        {`@keyframes peon-glass-sweep {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }`}
      </style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget definition + registration
// ---------------------------------------------------------------------------

const definition: WidgetDefinition = {
  type: "peon-glass",
  name: "Peon Glass",
  description:
    "Glassmorphism notification panel with accent bar and animated progress line",
  subscribesTo: [
    "thought",
    "action",
    "tool",
    "assistant",
    "evaluator",
    "new_viewer",
  ],
  defaultPosition: { x: 2, y: 2, width: 32, height: 40 },
  defaultZIndex: 16,
  configSchema: {
    accentColor: {
      type: "color",
      label: "Accent color",
      default: "#a78bfa",
    },
    maxItems: {
      type: "number",
      label: "Max visible items",
      default: 4,
      min: 1,
      max: 8,
    },
    displayDuration: {
      type: "number",
      label: "Display duration (ms)",
      default: 6000,
      min: 2000,
      max: 20000,
    },
  },
  defaultConfig: { accentColor: "#a78bfa", maxItems: 4, displayDuration: 6000 },
  render: PeonGlass,
};

registerWidget(definition);
export default definition;
