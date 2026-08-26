/**
 * AgentElementOverlay — draws labelled indicators over every agent-addressable
 * element when the view's registry has highlight mode on (toggled by the agent
 * via the `set-highlight` capability, or by the user via the pill). Lets the
 * user *see* exactly what the agent can target. Pointer-events are disabled so
 * it never intercepts clicks.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Badge } from "../components/ui/badge";
import { Card } from "../components/ui/card";
import { Z_SHELL_OVERLAY } from "../lib/floating-layers";
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
    let frameId: number | null = null;
    const onChange = () => {
      if (frameId !== null) return;
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        setTick((t) => t + 1);
      });
    };
    const scrollOptions = { capture: true, passive: true };
    window.addEventListener("scroll", onChange, scrollOptions);
    window.addEventListener("resize", onChange);
    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      window.removeEventListener("scroll", onChange, scrollOptions);
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
        zIndex: Z_SHELL_OVERLAY,
        pointerEvents: "none",
      }}
    >
      {visible.map((element) => {
        const b = element.bounds;
        if (!b) return null;
        return (
          <div
            key={element.id}
            style={{
              position: "fixed",
              left: b.x,
              top: b.y,
              width: b.width,
              height: b.height,
            }}
          >
            <Card
              data-agent-indicator={element.id}
              data-focused={element.focused}
              variant={element.focused ? "transparent" : "dashed"}
              border={element.focused ? "strong" : "default"}
              radius="large"
              surface="transparent"
              shadow="none"
              className="h-full w-full"
            >
              <Badge variant="visualAnchor" overlay="agentIndicatorLabel">
                {element.id}
              </Badge>
            </Card>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
