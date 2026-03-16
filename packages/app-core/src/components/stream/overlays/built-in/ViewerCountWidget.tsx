/**
 * ViewerCount — Compact badge showing live viewer count with a green dot.
 */

import { useMemo } from "react";
import { registerWidget } from "../registry";
import type { WidgetDefinition, WidgetRenderProps } from "../types";

function ViewerCount({ events }: WidgetRenderProps) {
  const count = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      const p = events[i].payload as Record<string, unknown>;
      if (typeof p.apiViewerCount === "number") return p.apiViewerCount;
      if (typeof p.uniqueChatters === "number") return p.uniqueChatters;
    }
    return null;
  }, [events]);

  if (count == null) return null;

  return (
    <div className="h-full flex items-start justify-start p-2">
      <div className="inline-flex items-center gap-1.5 bg-bg/80 border border-border/50 rounded-full px-2.5 py-1 backdrop-blur-sm shadow-sm">
        <span className="w-1.5 h-1.5 rounded-full bg-ok animate-pulse" />
        <span className="text-[11px] font-medium text-txt/90 tabular-nums">
          {count}
        </span>
      </div>
    </div>
  );
}

const definition: WidgetDefinition = {
  type: "viewer-count",
  name: "Viewer Count",
  description: "Live viewer count badge",
  subscribesTo: ["viewer_stats"],
  defaultPosition: { x: 0, y: 0, width: 10, height: 6 },
  defaultZIndex: 14,
  configSchema: {},
  defaultConfig: {},
  render: ViewerCount,
};

registerWidget(definition);
export default definition;
