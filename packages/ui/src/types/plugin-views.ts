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
  /** @deprecated use `views` */
  apps?: PluginViewRegistration[];
}
