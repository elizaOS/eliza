/**
 * OverlayLayer — Renders all enabled widget instances as absolute-positioned
 * DOM elements inside the StreamView content area.
 *
 * Z-index strategy:
 *   Content 0 | Widgets 10-39 | Alerts 40-49 | GameViewOverlay 50+
 */

import type { StreamEventEnvelope } from "@elizaos/app-core/api";
import { useMemo } from "react";
import type { AgentMode } from "../helpers";
import { getWidget } from "./registry";
import type { OverlayLayout } from "./types";

// Ensure all built-in widgets are registered
import "./built-in";

interface OverlayLayerProps {
  layout: OverlayLayout;
  events: StreamEventEnvelope[];
  agentMode: AgentMode;
  agentName: string;
}

export function OverlayLayer({
  layout,
  events,
  agentMode,
  agentName,
}: OverlayLayerProps) {
  const enabledWidgets = useMemo(
    () => layout.widgets.filter((w) => w.enabled),
    [layout.widgets],
  );

  if (enabledWidgets.length === 0) return null;

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ zIndex: 10 }}
    >
      {enabledWidgets.map((instance) => {
        const def = getWidget(instance.type);
        if (!def) return null;

        const filtered = events.filter(
          (e) => e.stream != null && def.subscribesTo.includes(e.stream),
        );
        const Widget = def.render;

        return (
          <div
            key={instance.id}
            className="absolute pointer-events-auto"
            style={{
              left: `${instance.position.x}%`,
              top: `${instance.position.y}%`,
              width: `${instance.position.width}%`,
              height: `${instance.position.height}%`,
              zIndex: instance.zIndex,
            }}
          >
            <Widget
              instance={instance}
              events={filtered}
              agentMode={agentMode}
              agentName={agentName}
            />
          </div>
        );
      })}
    </div>
  );
}
