/**
 * Chat workspace widget bar.
 *
 * Desktop: persistent right rail alongside /chat. Collapses to a thin strip
 *          with a floating expand button. The footer carries the panel
 *          collapse and an Edit affordance that opens the visibility panel
 *          where the user picks which widgets show.
 * Mobile:  alternate chat workspace view toggled from the chat header. No
 *          collapse / edit affordances — parent hides the panel entirely.
 *
 * Renders the `chat-sidebar` widget slot via the plugin widget system,
 * filtered through `useChatSidebarVisibility` so user overrides apply.
 */
import type { ActivityEvent } from "../../hooks/useActivityEvents";
import { APPS_SECTION_VISIBILITY_KEY } from "../../widgets/visibility";
interface TasksEventsPanelProps {
    open: boolean;
    /** Activity events from the parent — kept alive even when the panel unmounts. */
    events: ActivityEvent[];
    clearEvents: () => void;
    /** When true, renders as full-width mobile content. */
    mobile?: boolean;
    /** Desktop-only: when true the panel collapses to a thin strip. */
    collapsed?: boolean;
    /** Desktop-only: called when the user toggles the collapsed state. */
    onToggleCollapsed?: (next: boolean) => void;
}
export declare function TasksEventsPanel({ open, events, clearEvents, mobile, collapsed, onToggleCollapsed, }: TasksEventsPanelProps): import("react/jsx-runtime").JSX.Element | null;
export { APPS_SECTION_VISIBILITY_KEY };
//# sourceMappingURL=TasksEventsPanel.d.ts.map