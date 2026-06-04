/**
 * AgentElementOverlay — draws labelled indicators over every agent-addressable
 * element when the view's registry has highlight mode on (toggled by the agent
 * via the `set-highlight` capability, or by the user via the pill). Lets the
 * user *see* exactly what the agent can target. Pointer-events are disabled so
 * it never intercepts clicks.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useAgentSurface } from "./AgentSurfaceContext.hooks";

const noopSubscribe = () => () => {};

export function AgentElementOverlay() {
  const surface = useAgentSurface();
  const registry = surface?.registry ?? null;

  // Re-render whenever the registry mutates (elements, status, highlight flag).
  useSyncExternalStore(
    registry ? registry.subscribe : noopSubscribe,
    registry ? registry.getVersion : () => 0,
    () => 0,
  );

  // Re-measure on scroll / resize while highlighting so boxes track the layout.
  const [, setTick] = useState(0);
  const highlighting = registry?.isHighlighting() ?? false;
  useEffect(() => {
    if (!highlighting || typeof window === "undefined") return;
    const onChange = () => setTick((t) => t + 1);
    window.addEventListener("scroll", onChange, true);
    window.addEventListener("resize", onChange);
    return () => {
      window.removeEventListener("scroll", onChange, true);
      window.removeEventListener("resize", onChange);
    };
  }, [highlighting]);

  if (!registry || !highlighting || typeof document === "undefined")
    return null;

  const snapshot = registry.snapshot();
  const visible = snapshot.elements.filter((e) => e.visible && e.bounds);

  return createPortal(
    <div
      data-agent-overlay
      aria-hidden
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        pointerEvents: "none",
      }}
    >
      {visible.map((element) => {
        const b = element.bounds;
        if (!b) return null;
        return (
          <div
            key={element.id}
            data-agent-indicator={element.id}
            style={{
              position: "fixed",
              left: b.x,
              top: b.y,
              width: b.width,
              height: b.height,
              border: element.focused
                ? "2px solid var(--accent, #ff7300)"
                : "1px dashed var(--accent, #ff7300)",
              borderRadius: 6,
              boxShadow: element.focused
                ? "0 0 0 2px var(--accent-muted, rgba(255,115,0,0.35))"
                : "none",
              boxSizing: "border-box",
            }}
          >
            <span
              style={{
                position: "absolute",
                top: -16,
                left: 0,
                fontSize: 10,
                lineHeight: "14px",
                padding: "0 4px",
                borderRadius: 4,
                color: "var(--accent-foreground, #fff)",
                background: "var(--accent, #ff7300)",
                whiteSpace: "nowrap",
                fontFamily: "var(--font-mono, monospace)",
              }}
            >
              {element.id}
            </span>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
