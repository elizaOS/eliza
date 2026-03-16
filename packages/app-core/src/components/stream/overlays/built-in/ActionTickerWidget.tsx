/**
 * ActionTicker — Horizontal scrolling strip of recent agent actions/tool calls.
 * Follows the ChatTicker pattern.
 */

import { useApp } from "@elizaos/app-core/state";
import { useMemo } from "react";
import { getEventText } from "../../helpers";
import { registerWidget } from "../registry";
import type { WidgetDefinition, WidgetRenderProps } from "../types";

function ActionTicker({ instance, events }: WidgetRenderProps) {
  const { t } = useApp();
  const maxItems = (instance.config.maxItems as number) ?? 8;

  const items = useMemo(() => {
    return events.slice(-maxItems).map((e) => ({
      id: e.eventId,
      stream: e.stream ?? "action",
      text: getEventText(e),
    }));
  }, [events, maxItems]);

  if (items.length === 0) return null;

  return (
    <div className="h-full flex items-center px-3 bg-bg/70 border-b border-border/30 backdrop-blur-sm overflow-hidden">
      <div className="flex items-center gap-4 text-[11px] text-muted overflow-x-auto whitespace-nowrap scrollbar-hide">
        <span className="text-[9px] uppercase tracking-wider text-muted/60 shrink-0 font-medium">
          {t("actiontickerwidget.actions")}
        </span>
        {items.map((item) => (
          <span key={item.id} className="shrink-0">
            <span className="text-txt/70">[{item.stream}]</span>{" "}
            <span className="text-txt/80">{item.text.slice(0, 60)}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

const definition: WidgetDefinition = {
  type: "action-ticker",
  name: "Action Ticker",
  description: "Scrolling strip of recent agent actions and tool calls",
  subscribesTo: ["action", "tool"],
  defaultPosition: { x: 0, y: 0, width: 100, height: 4 },
  defaultZIndex: 12,
  configSchema: {
    maxItems: {
      type: "number",
      label: "Max visible items",
      default: 8,
      min: 3,
      max: 20,
    },
  },
  defaultConfig: { maxItems: 8 },
  render: ActionTicker,
};

registerWidget(definition);
export default definition;
