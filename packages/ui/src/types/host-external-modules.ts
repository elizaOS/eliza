import type { ComponentType, ReactNode } from "react";

declare module "@elizaos/plugin-training" {
  export const FineTuningView: ComponentType<Record<string, unknown>>;
}

declare module "@elizaos/plugin-vector-browser" {
  export const VectorBrowserView: ComponentType<{
    leftNav?: ReactNode;
    contentHeader?: ReactNode;
  }>;
}
