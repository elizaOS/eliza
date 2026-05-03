import type { ComponentType } from "react";
import type { PluginInfo } from "../../../api";
import type { ActivityEvent } from "../../../hooks/useActivityEvents";

export interface ChatSidebarWidgetProps {
  events: ActivityEvent[];
  clearEvents: () => void;
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
