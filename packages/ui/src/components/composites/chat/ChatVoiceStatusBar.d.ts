/**
 * ChatVoiceStatusBar — live status strip shown above the composer while
 * continuous chat is on (R10 §2.3).
 *
 * Surfaces:
 * - status dot (idle / listening / thinking / speaking / interrupting)
 * - live partial transcript
 * - speaker pill (name + OWNER crown when entityId matches owner)
 * - interrupt indicator
 * - latency badge (speechEnd → voiceStart) with traffic-light colouring
 */
import type * as React from "react";
import type { ContinuousChatLatency } from "../../../hooks/useContinuousChat";
import type { VoiceContinuousStatus, VoiceSpeakerMetadata } from "../../../voice/voice-chat-types";
export interface ChatVoiceStatusBarProps {
    status: VoiceContinuousStatus;
    interimTranscript?: string;
    speaker?: VoiceSpeakerMetadata | null;
    /** Owner entity id from runtime config; speakers matching get a Crown. */
    ownerEntityId?: string | null;
    latency?: ContinuousChatLatency;
    /** Visible only when continuous mode is on AND we have something to show. */
    visible?: boolean;
    className?: string;
    "data-testid"?: string;
}
export declare function ChatVoiceStatusBar({ status, interimTranscript, speaker, ownerEntityId, latency, visible, className, "data-testid": dataTestId, }: ChatVoiceStatusBarProps): React.ReactElement | null;
export default ChatVoiceStatusBar;
//# sourceMappingURL=ChatVoiceStatusBar.d.ts.map