/**
 * VoicePrefixGate — mounts the VoicePrefixSteps sub-flow before RuntimeGate.
 *
 * Rendered by StartupShell on first boot when `loadVoicePrefixDone()` is
 * false. When the user completes or explicitly skips the flow, `onDone` is
 * called, which persists the flag and hands control back to StartupShell
 * (which then renders RuntimeGate).
 *
 * Keeps its own step state so the parent doesn't need to know about
 * VoicePrefixStep internals. Defensive: the VoiceProfilesClient falls back
 * gracefully when the server endpoints aren't live (I2 may not have landed).
 */
import * as React from "react";
export interface VoicePrefixGateProps {
    /** Called when the user completes or skips the voice prefix flow. */
    onDone: () => void;
}
export declare function VoicePrefixGate({ onDone, }: VoicePrefixGateProps): React.ReactElement;
export default VoicePrefixGate;
//# sourceMappingURL=VoicePrefixGate.d.ts.map