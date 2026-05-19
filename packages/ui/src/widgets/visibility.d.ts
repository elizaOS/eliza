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
declare const CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY = "eliza:chat-sidebar:visibility";
/**
 * Synthetic widget id reserved for the bespoke `AppsSection` rendered in
 * {@link ../components/chat/TasksEventsPanel.tsx}. Lets the same edit panel
 * toggle Apps even though it's not a registry widget.
 */
export declare const APPS_SECTION_VISIBILITY_KEY = "app-core/apps.section";
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
export declare function widgetVisibilityKey(pluginId: string, id: string): string;
export declare function loadChatSidebarVisibility(): WidgetVisibilityState;
export declare function saveChatSidebarVisibility(state: WidgetVisibilityState): void;
/**
 * Decide whether a widget should be visible right now.
 * - Explicit `true` override → visible.
 * - Explicit `false` override → hidden.
 * - No override → fall back to `defaultEnabled` (defaults to `true` when omitted,
 *   matching the registry's `defaultEnabled !== false` convention).
 */
export declare function isWidgetVisible(candidate: VisibilityCandidate, overrides: Record<string, boolean>): boolean;
/**
 * Filter a list of resolved widgets through the override map. Preserves the
 * input order so the registry's `order` field continues to drive layout.
 */
export declare function applyChatSidebarVisibility<T extends {
    declaration: VisibilityCandidate;
}>(resolved: readonly T[], overrides: Record<string, boolean>): T[];
export { CHAT_SIDEBAR_VISIBILITY_STORAGE_KEY };
//# sourceMappingURL=visibility.d.ts.map