/**
 * AlertPopup — Animated fade-in/out card for new viewer joins and chat triggers.
 */

import { useEffect, useMemo, useState } from "react";
import { getEventFrom, getEventText } from "../../helpers";
import { registerWidget } from "../registry";
import type { WidgetDefinition, WidgetRenderProps } from "../types";

interface AlertEntry {
  id: string;
  title: string;
  body: string;
}

function AlertPopup({ instance, events }: WidgetRenderProps) {
  const displayMs = (instance.config.displayDuration as number) ?? 5000;

  const latest = useMemo(() => {
    if (events.length === 0) return null;
    const e = events[events.length - 1];
    const from = getEventFrom(e);
    const isViewer = e.stream === "new_viewer";
    return {
      id: e.eventId,
      title: isViewer ? "New Viewer!" : (from ?? "Alert"),
      body: isViewer
        ? `${from ?? "Someone"} joined the stream`
        : getEventText(e),
    } satisfies AlertEntry;
  }, [events]);

  const [shown, setShown] = useState<AlertEntry | null>(null);
  const [fading, setFading] = useState(false);

  useEffect(() => {
    if (!latest) return;
    setShown(latest);
    setFading(false);

    const fadeTimer = setTimeout(() => setFading(true), displayMs - 500);
    const hideTimer = setTimeout(() => setShown(null), displayMs);

    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(hideTimer);
    };
  }, [latest, displayMs]);

  if (!shown) return null;

  return (
    <div className="h-full flex items-start justify-end p-2">
      <div
        className={`bg-bg/90 border border-accent/40 rounded-lg px-4 py-3 backdrop-blur-sm shadow-lg max-w-[280px] transition-opacity duration-500 ${fading ? "opacity-0" : "opacity-100"}`}
      >
        <p className="text-xs font-medium text-txt">{shown.title}</p>
        <p className="text-[11px] text-txt/80 mt-0.5 leading-snug">
          {shown.body}
        </p>
      </div>
    </div>
  );
}

const definition: WidgetDefinition = {
  type: "alert-popup",
  name: "Alert Popup",
  description: "Animated alerts for new viewers and chat messages",
  subscribesTo: ["new_viewer", "message"],
  defaultPosition: { x: 65, y: 5, width: 33, height: 15 },
  defaultZIndex: 40,
  configSchema: {
    displayDuration: {
      type: "number",
      label: "Display duration (ms)",
      default: 5000,
      min: 2000,
      max: 15000,
    },
  },
  defaultConfig: { displayDuration: 5000 },
  render: AlertPopup,
};

registerWidget(definition);
export default definition;
