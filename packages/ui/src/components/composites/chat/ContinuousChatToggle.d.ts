/**
 * ContinuousChatToggle — three-segment switch that lives in the chat header.
 *
 * R10 §2.1 / §2.3. Off / VAD-gated / Always-on.
 *
 * - On wide layouts: three pill buttons inline.
 * - On narrow / mobile layouts: collapses to a single icon button (Mic) that
 *   shows the active mode and opens a sheet on tap; the caller renders the
 *   sheet (we just expose the toggle + a click handler).
 */
import * as React from "react";
import { type VoiceContinuousMode } from "../../../voice/voice-chat-types";
export interface ContinuousChatToggleProps {
    value: VoiceContinuousMode;
    onChange: (next: VoiceContinuousMode) => void;
    /** Disable user interaction (e.g. mic permission denied, no STT). */
    disabled?: boolean;
    /** Render the compact (single-icon) variant. */
    compact?: boolean;
    className?: string;
    /** Test/automation hook. */
    "data-testid"?: string;
}
export declare function ContinuousChatToggle({ value, onChange, disabled, compact, className, "data-testid": dataTestId, }: ContinuousChatToggleProps): React.ReactElement;
export default ContinuousChatToggle;
//# sourceMappingURL=ContinuousChatToggle.d.ts.map