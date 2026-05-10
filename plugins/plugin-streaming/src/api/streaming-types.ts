// Re-export the canonical definitions from core.ts so all consumers
// resolve to a single nominal type. Local file kept to preserve the
// import path used by adjacent modules in this plugin.
export type {
  OverlayLayoutData,
  OverlayWidgetInstance,
  StreamingDestination,
} from "../core.ts";
