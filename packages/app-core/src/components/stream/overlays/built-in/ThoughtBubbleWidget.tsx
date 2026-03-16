/**
 * ThoughtBubble — Shows the agent's latest thought/reasoning, auto-fades
 * after a configurable delay.
 */

import { useEffect, useMemo, useState } from "react";
import { getEventText } from "../../helpers";
import { registerWidget } from "../registry";
import type { WidgetDefinition, WidgetRenderProps } from "../types";

function ThoughtBubble({ instance, events }: WidgetRenderProps) {
  const fadeMs = (instance.config.fadeDuration as number) ?? 8000;
  const maxLen = (instance.config.maxLength as number) ?? 200;

  const latest = useMemo(() => {
    if (events.length === 0) return null;
    return events[events.length - 1];
  }, [events]);

  const [visible, setVisible] = useState(false);
  const [text, setText] = useState("");

  useEffect(() => {
    if (!latest) return;
    const content = getEventText(latest);
    setText(content.length > maxLen ? `${content.slice(0, maxLen)}…` : content);
    setVisible(true);

    const timer = setTimeout(() => setVisible(false), fadeMs);
    return () => clearTimeout(timer);
  }, [latest, fadeMs, maxLen]);

  if (!visible || !text) return null;

  return (
    <div
      className="h-full flex items-end justify-center px-2 pb-2 transition-opacity duration-500"
      style={{ opacity: visible ? 1 : 0 }}
    >
      <div className="bg-bg/80 border border-border/50 rounded-lg px-4 py-2.5 backdrop-blur-sm shadow-lg max-w-full">
        <p className="text-xs text-muted leading-relaxed line-clamp-3">
          💭 {text}
        </p>
      </div>
    </div>
  );
}

const definition: WidgetDefinition = {
  type: "thought-bubble",
  name: "Thought Bubble",
  description: "Shows the agent's latest thought or reasoning",
  subscribesTo: ["thought", "assistant", "evaluator"],
  defaultPosition: { x: 15, y: 75, width: 70, height: 20 },
  defaultZIndex: 15,
  configSchema: {
    fadeDuration: {
      type: "number",
      label: "Fade delay (ms)",
      default: 8000,
      min: 2000,
      max: 30000,
    },
    maxLength: {
      type: "number",
      label: "Max text length",
      default: 200,
      min: 50,
      max: 500,
    },
  },
  defaultConfig: { fadeDuration: 8000, maxLength: 200 },
  render: ThoughtBubble,
};

registerWidget(definition);
export default definition;
