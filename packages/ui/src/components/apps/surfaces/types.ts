import type { ComponentType } from "react";

export type AppOperatorSurfaceVariant = "detail" | "live" | "running";
export type AppOperatorSurfaceFocus = "all" | "dashboard" | "chat";

export interface AppOperatorSurfaceProps {
  appName: string;
  variant?: AppOperatorSurfaceVariant;
  focus?: AppOperatorSurfaceFocus;
}

export type AppOperatorSurfaceComponent =
  ComponentType<AppOperatorSurfaceProps>;
