/**
 * User-controlled visibility overrides for `chat-sidebar` widgets.
 *
 * Layered on top of the existing two-stage gate in
 * {@link ./registry.ts | resolveWidgetsForSlot}:
 *
 *   1. Plugin enabled?  →  declaration.defaultEnabled  →  user override
 *
 * The override layer is per-user, persisted to localStorage. When a widget's
 * id is absent from the override map we fall back to `declaration.defaultEnabled`,
 * so default flips don't reset users who never touched the toggle.
 *
 * Wallet/browser widgets that have not yet shipped get the same treatment:
 * once their plugin loads them, they appear with `defaultEnabled` and the user
 * can hide them via the same panel.
 */

const CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY = "eliza:chat-sidebar:visibility";

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
  } catch (err) {
    console.warn(
      "[widget-visibility] localStorage operation failed:",
      err instanceof Error ? err.message : err,
    );
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

export function loadChatSidebarVisibility(): WidgetVisibilityState {
  return tryLocalStorage(
    () => {
      const raw = localStorage.getItem(CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY);
      if (!raw) return { overrides: {} };
      const parsed = JSON.parse(raw) as unknown;
      return { overrides: sanitizeOverrides(parsed) };
    },
    { overrides: {} },
  );
}

export function saveChatSidebarVisibility(state: WidgetVisibilityState): void {
  tryLocalStorage(() => {
    const sanitized = sanitizeOverrides(state.overrides);
    if (Object.keys(sanitized).length === 0) {
      localStorage.removeItem(CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY);
      return;
    }
    localStorage.setItem(
      CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY,
      JSON.stringify(sanitized),
    );
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

export { CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY };
