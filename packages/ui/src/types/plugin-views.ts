/**
 * Props contract for plugin-provided view components (agentId in).
 */
import type { ComponentType } from "react";

export interface PluginViewProps {
  agentId: string;
}

export interface PluginViewRegistration {
  id: string;
  title: string;
  description?: string;
  icon?: ComponentType;
  component: ComponentType<PluginViewProps>;
  permissions?: string[];
  developerOnly?: boolean;
}

export interface ElizaPluginViews {
  views?: PluginViewRegistration[];
}
