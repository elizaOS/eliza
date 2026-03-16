/**
 * Stream overlay widget type system.
 *
 * Widget Definition (blueprint) → Widget Instance (placed on canvas) →
 * OverlayLayer (renders all enabled instances).
 */

import type { StreamEventEnvelope } from "@elizaos/app-core/api";
import type { ComponentType } from "react";
import type { AgentMode } from "../helpers";

// ---------------------------------------------------------------------------
// Position & Config
// ---------------------------------------------------------------------------

/** Percentage-based position (0-100% of 1280×720 canvas). */
export interface WidgetPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WidgetConfigField {
  type: "string" | "number" | "boolean" | "select" | "color";
  label: string;
  default: unknown;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
}

// ---------------------------------------------------------------------------
// Widget Definition (blueprint registered in the registry)
// ---------------------------------------------------------------------------

export interface WidgetDefinition {
  /** Unique type key, e.g. "thought-bubble", "custom-html". */
  type: string;
  /** Human-readable display name. */
  name: string;
  description: string;
  /** Which event streams this widget subscribes to (filters events). */
  subscribesTo: string[];
  defaultPosition: WidgetPosition;
  defaultZIndex: number;
  /** Schema for auto-generated settings UI. */
  configSchema: Record<string, WidgetConfigField>;
  defaultConfig: Record<string, unknown>;
  /** React component that renders the widget content. */
  render: ComponentType<WidgetRenderProps>;
}

// ---------------------------------------------------------------------------
// Widget Instance (JSON-serializable, persisted in localStorage)
// ---------------------------------------------------------------------------

export interface WidgetInstance {
  id: string;
  /** References WidgetDefinition.type. */
  type: string;
  enabled: boolean;
  position: WidgetPosition;
  zIndex: number;
  config: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Render props passed to each widget component
// ---------------------------------------------------------------------------

export interface WidgetRenderProps {
  instance: WidgetInstance;
  /** Events filtered to the widget's subscribesTo streams. */
  events: StreamEventEnvelope[];
  agentMode: AgentMode;
  agentName: string;
}

// ---------------------------------------------------------------------------
// Overlay Layout (persisted structure)
// ---------------------------------------------------------------------------

export interface OverlayLayout {
  version: 1;
  name: string;
  widgets: WidgetInstance[];
  /** The destination this layout is associated with (metadata only). */
  destinationId?: string;
}
