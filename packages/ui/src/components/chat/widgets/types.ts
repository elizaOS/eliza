/** Props + registration shape for chat-sidebar / home-slot widgets. */
import type { ComponentType } from "react";
import type { PluginInfo } from "../../../api";
import type { ActivityEvent } from "../../../hooks/useActivityEvents";
import type { WidgetSlot } from "../../../widgets/types";

export interface ChatSidebarWidgetProps {
  events: ActivityEvent[];
  clearEvents: () => void;
  /** The slot this instance renders in — `home` widgets hide their empty state. */
  slot?: WidgetSlot;
  /**
   * Static Tailwind grid-span classes for the home 4-col grid (mirrors
   * WidgetProps.spanClassName). The widget applies this to its single root
   * grid-item element when rendering on `home`. Absent off the home slot.
   */
  spanClassName?: string;
}

export interface ChatSidebarWidgetDefinition {
  id: string;
  pluginId: string;
  order: number;
  defaultEnabled: boolean;
  Component: ComponentType<ChatSidebarWidgetProps>;
}

export type ChatSidebarPluginState = Pick<
  PluginInfo,
  "id" | "enabled" | "isActive"
>;
