import "./voice-pill.css";
export interface VoicePillMessage {
    id: string;
    role: "agent" | "user";
    text: string;
}
export interface VoicePillProps {
    /** Controlled open state. If omitted, component manages its own. */
    open?: boolean;
    /** Fired when the open state changes (click on pill-hit). */
    onOpenChange?: (open: boolean) => void;
    /** "Always-on recording" flag. Red pulse when true. */
    recording?: boolean;
    /** Fired when the mic button toggles recording. */
    onRecordingChange?: (recording: boolean) => void;
    /** Conversation rendered in the expanded panel. */
    messages?: VoicePillMessage[];
    /** Composer placeholder. Default "Ask Eliza…" */
    placeholder?: string;
    /** Called when user submits text via Enter or send. Component clears input after. */
    onSubmit?: (text: string) => void;
    /** Called when user clicks the + button. */
    onAdd?: () => void;
    /** aria-label for the pill. Default "Eliza". */
    ariaLabel?: string;
    /** Extra className on the outer container. */
    className?: string;
}
export declare function VoicePill(props: VoicePillProps): import("react/jsx-runtime").JSX.Element;
export declare namespace VoicePill {
    var displayName: string;
}
export default VoicePill;
//# sourceMappingURL=VoicePill.d.ts.map