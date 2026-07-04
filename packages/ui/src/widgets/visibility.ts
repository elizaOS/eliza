/**
 * User-controlled per-slot widget visibility overrides, layered on top of the
 * two-stage capability/declaration gate (see block below).
 */
import type { WidgetSlot } from "./types";

/**
 * User-controlled visibility overrides for widget slots.
 *
 * Layered on top of the existing two-stage gate in
 * {@link ./registry.ts | resolveWidgetsForSlot}:
 *
 *   1. Plugin enabled?  →  declaration.defaultEnabled  →  user override
 *
 * The override layer is per-user and per-slot, persisted to localStorage. When
 * a widget's id is absent from the override map we fall back to
 * `declaration.defaultEnabled`, so default flips don't reset users who never
 * touched the toggle.
 *
 * Active widget slots use the same path once their plugin registers them: they
 * appear with `defaultEnabled` and the user can hide them via the same panel.
 */

const CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY = "eliza:chat-sidebar:visibility";
const WIDGET_VISIBILITY_STORAGE_KEY_PREFIX = "eliza:widget-visibility";

/**
 * Synthetic widget id reserved for the bespoke `AppsSection` rendered in
 * {@link ../components/chat/TasksEventsPanel.tsx}. Lets the same edit panel
 * toggle Apps even though it's not a registry widget.
 */
export const APPS_SECTION_VISIBILITY_KEY = "app-core/apps.section";

export interface WidgetVisibilityState {
  /**
   * Map of `${pluginId}/${declarationId}` → boolean.
   * Absent key means "use the declaration's defaultEnabled".
   */
  overrides: Record<string, boolean>;
}

export interface VisibilityCandidate {
  pluginId: string;
  id: string;
  defaultEnabled?: boolean;
}

export function widgetVisibilityKey(pluginId: string, id: string): string {
  return `${pluginId}/${id}`;
}

function tryLocalStorage<T>(fn: () => T, fallback: T): T {
  if (typeof localStorage === "undefined") return fallback;
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function sanitizeOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") return {};
  const next: Record<string, boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== "string" || key.length === 0) continue;
    if (typeof raw === "boolean") next[key] = raw;
  }
  return next;
}

export function widgetVisibilityStorageKey(slot: WidgetSlot): string {
  // Keep the original chat-sidebar key for backward compatibility with users'
  // existing sidebar overrides.
  if (slot === "chat-sidebar") return CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY;
  return `${WIDGET_VISIBILITY_STORAGE_KEY_PREFIX}:${slot}`;
}

export function loadWidgetVisibility(
  slot: WidgetSlot = "chat-sidebar",
): WidgetVisibilityState {
  return tryLocalStorage(
    () => {
      const raw = localStorage.getItem(widgetVisibilityStorageKey(slot));
      if (!raw) return { overrides: {} };
      const parsed = JSON.parse(raw) as unknown;
      return { overrides: sanitizeOverrides(parsed) };
    },
    { overrides: {} },
  );
}

export function saveWidgetVisibility(
  state: WidgetVisibilityState,
  slot: WidgetSlot = "chat-sidebar",
): void {
  tryLocalStorage(() => {
    const sanitized = sanitizeOverrides(state.overrides);
    const key = widgetVisibilityStorageKey(slot);
    if (Object.keys(sanitized).length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(sanitized));
  }, undefined);
}

/**
 * Decide whether a widget should be visible right now.
 * - Explicit `true` override → visible.
 * - Explicit `false` override → hidden.
 * - No override → fall back to `defaultEnabled` (defaults to `true` when omitted,
 *   matching the registry's `defaultEnabled !== false` convention).
 */
export function isWidgetVisible(
  candidate: VisibilityCandidate,
  overrides: Record<string, boolean>,
): boolean {
  const key = widgetVisibilityKey(candidate.pluginId, candidate.id);
  if (Object.hasOwn(overrides, key)) {
    return overrides[key] === true;
  }
  return candidate.defaultEnabled !== false;
}

/**
 * Filter a list of resolved widgets through the override map. Preserves the
 * input order so the registry's `order` field continues to drive layout.
 */
export function applyChatSidebarVisibility<
  T extends { declaration: VisibilityCandidate },
>(resolved: readonly T[], overrides: Record<string, boolean>): T[] {
  return resolved.filter((entry) =>
    isWidgetVisible(entry.declaration, overrides),
  );
}

export const applyWidgetVisibility = applyChatSidebarVisibility;
export const loadChatSidebarVisibility = loadWidgetVisibility;
export const saveChatSidebarVisibility = saveWidgetVisibility;

export {
  CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY,
  WIDGET_VISIBILITY_STORAGE_KEY_PREFIX,
};
