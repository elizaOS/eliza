/**
 * In-memory widget registry.
 *
 * Built-in widgets self-register on import via `registerWidget()`.
 * External code looks up definitions with `getWidget()` / `getAllWidgets()`.
 */

import type { WidgetDefinition } from "./types";

const widgets = new Map<string, WidgetDefinition>();

export function registerWidget(def: WidgetDefinition): void {
  widgets.set(def.type, def);
}

export function getWidget(type: string): WidgetDefinition | undefined {
  return widgets.get(type);
}

export function getAllWidgets(): WidgetDefinition[] {
  return Array.from(widgets.values());
}
