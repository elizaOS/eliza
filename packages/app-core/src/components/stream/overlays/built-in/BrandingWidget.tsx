/**
 * Branding — Static agent name / logo watermark in the corner.
 */

import { registerWidget } from "../registry";
import type { WidgetDefinition, WidgetRenderProps } from "../types";

function Branding({ instance, agentName }: WidgetRenderProps) {
  const opacity = (instance.config.opacity as number) ?? 0.6;
  const showLabel = (instance.config.showLabel as boolean) ?? true;

  return (
    <div className="h-full flex items-end justify-end p-2" style={{ opacity }}>
      <div className="bg-bg/60 border border-border/30 rounded-md px-3 py-1.5 backdrop-blur-sm">
        {showLabel && (
          <p className="text-[10px] uppercase tracking-widest text-muted/80 font-medium">
            {agentName}
          </p>
        )}
      </div>
    </div>
  );
}

const definition: WidgetDefinition = {
  type: "branding",
  name: "Branding",
  description: "Agent name/logo watermark",
  subscribesTo: [],
  defaultPosition: { x: 78, y: 90, width: 20, height: 8 },
  defaultZIndex: 11,
  configSchema: {
    opacity: {
      type: "number",
      label: "Opacity",
      default: 0.6,
      min: 0.1,
      max: 1,
    },
    showLabel: {
      type: "boolean",
      label: "Show agent name",
      default: true,
    },
  },
  defaultConfig: { opacity: 0.6, showLabel: true },
  render: Branding,
};

registerWidget(definition);
export default definition;
