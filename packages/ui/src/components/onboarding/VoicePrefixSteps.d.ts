/**
 * VoicePrefixSteps — 7-step voice onboarding sub-flow (R10 §3).
 *
 * Self-contained renderer: caller mounts <VoicePrefixSteps step={…} … />
 * inside the onboarding shell and supplies callbacks. Each step renders a
 * focused affordance + a Continue button. R10 §3.2 specifies the copy +
 * branching; we render exactly that.
 *
 * Adapter inputs:
 * - `tier` from I9 (defaults to "GOOD" when unknown — never blocks the flow).
 * - `profilesClient` from I2 (defaults are baked into the adapter when the
 *   server endpoints aren't live yet).
 * - `onModelDownloadStart` from I5 (caller no-ops when versioning isn't
 *   wired — we fall through to "Continue in background").
 */
import * as React from "react";
import type { VoiceCaptureSubmitResult, VoiceProfilesClient } from "../../api/client-voice-profiles";
import { type VoicePrefixStep } from "../../onboarding/voice-prefix";
import { type VoiceDeviceTier } from "../settings/VoiceTierBanner";
export interface VoicePrefixStepsProps {
    /** Active step. Caller drives this — voice-prefix.ts has next/prev helpers. */
    step: VoicePrefixStep;
    /** Device tier from I9; null falls back to "GOOD" copy. */
    tier: VoiceDeviceTier | null;
    /** Optional summary line for the tier banner. */
    tierSummary?: string;
    /** Adapter to I2's voice profile endpoints. */
    profilesClient: VoiceProfilesClient;
    /** Caller plays a scripted greeting via the chosen TTS (step 4). */
    onAgentSpeak?: (script: string) => void;
    /** Caller requests microphone permission. Returns true if granted. */
    onRequestMicPermission?: () => Promise<boolean>;
    /** Caller kicks off voice model download (I5). No-op if not wired. */
    onModelDownloadStart?: () => void;
    /** Caller advances to the next step. */
    onAdvance: (next: VoicePrefixStep | null) => void;
    /** Caller goes back. */
    onBack: () => void;
    /** Caller skips remaining voice steps and jumps to the legacy flow. */
    onSkipPrefix?: () => void;
    /** OWNER name editor handler — passed the captured display name. */
    onOwnerSaved?: (result: VoiceCaptureSubmitResult & {
        displayName: string;
    }) => void;
    /** Optional initial display name for the OWNER (e.g. from cloud profile). */
    initialOwnerDisplayName?: string;
}
export declare function VoicePrefixSteps(props: VoicePrefixStepsProps): React.ReactElement;
export default VoicePrefixSteps;
//# sourceMappingURL=VoicePrefixSteps.d.ts.map