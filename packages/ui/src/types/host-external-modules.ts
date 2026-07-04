/**
 * Ambient module declarations for host-provided external plugin views (e.g.
 * plugin-training's FineTuningView) the shell lazy-loads.
 */
import type { ComponentType } from "react";

declare module "@elizaos/plugin-training" {
  export const FineTuningView: ComponentType<Record<string, unknown>>;
}
