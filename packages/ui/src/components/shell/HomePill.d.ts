import * as React from "react";
import type { ShellPhase } from "./shell-state";
export interface HomePillProps {
    phase: ShellPhase;
    onOpen: () => void;
    onClose: () => void;
}
/**
 * Persistent home pill at the bottom-center of the viewport. Tapping it
 * toggles the AssistantOverlay; visual state reflects the shell phase.
 *
 * Pure visual + click handler — does not own state. Consumers wire `phase`
 * and the open/close handlers.
 *
 * During the booting phase the button is `disabled` so a click does not
 * silently fire onOpen() against a reducer that would ignore it.
 */
export declare function HomePill({ phase, onOpen, onClose, }: HomePillProps): React.JSX.Element;
//# sourceMappingURL=HomePill.d.ts.map