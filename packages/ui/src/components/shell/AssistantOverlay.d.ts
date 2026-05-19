import * as React from "react";
import type { ShellPhase } from "./shell-state";
export interface AssistantOverlayProps {
    phase: ShellPhase;
    onClose: () => void;
    children: React.ReactNode;
}
/**
 * Bottom-sheet / centered-drawer container for the assistant chat.
 *
 * - Renders children only when phase ∈ {summoned, listening, responding}
 * - Listens for Escape on `document` to invoke onClose
 * - Aria: role=dialog + aria-modal=true so screen readers announce it
 * - Focus management (WAI-ARIA Dialog pattern):
 *   - On open: remembers the previously focused element and moves focus
 *     into the dialog (first focusable descendant, or the dialog itself).
 *   - While open: Tab and Shift+Tab cycle within the dialog only.
 *   - On close: restores focus to the previously focused element.
 *
 * Animation is a single CSS keyframe (defined in base.css as
 * `@keyframes shell-overlay-in`) on enter; respects
 * `prefers-reduced-motion` via Tailwind's `motion-safe:` prefix.
 */
export declare function AssistantOverlay({ phase, onClose, children, }: AssistantOverlayProps): React.JSX.Element | null;
//# sourceMappingURL=AssistantOverlay.d.ts.map