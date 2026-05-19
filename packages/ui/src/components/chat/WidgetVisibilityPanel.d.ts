/**
 * Edit which `chat-sidebar` widgets are visible.
 *
 * Renders inline inside the chat widgets sidebar, replacing the normal widget
 * content while the user is editing. Toggling a row clears or sets a user
 * visibility override — toggling back to the default clears the override
 * entirely so future default changes still propagate.
 */
import type { ReactNode } from "react";
import type { ChatSidebarVisibilityHook } from "../../widgets/useChatSidebarVisibility";
import { type VisibilityCandidate } from "../../widgets/visibility";
export interface WidgetVisibilityCandidate extends VisibilityCandidate {
    /** Display label shown next to the toggle. */
    label: string;
    /** Optional icon node rendered to the left of the label. */
    icon?: ReactNode;
}
export interface WidgetVisibilityEditorProps {
    candidates: readonly WidgetVisibilityCandidate[];
    visibility: ChatSidebarVisibilityHook;
    onClose: () => void;
}
export declare function buildAppsSectionVisibilityCandidate(): WidgetVisibilityCandidate;
export declare function WidgetVisibilityEditor({ candidates, visibility, onClose, }: WidgetVisibilityEditorProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=WidgetVisibilityPanel.d.ts.map