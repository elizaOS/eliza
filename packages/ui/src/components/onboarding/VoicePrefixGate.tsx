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
import { client } from "../../api/client";
import { createVoiceProfilesClient } from "../../api/client-voice-profiles";
import { useDefaultProviderPresets } from "../../hooks/useDefaultProviderPresets";
import { useVoiceChat } from "../../hooks/useVoiceChat";
import type { VoicePrefixStep } from "../../onboarding/voice-prefix";
import { applyVoiceProviderDefaults } from "../../voice/character-voice-config";
import { VoicePrefixSteps } from "./VoicePrefixSteps";

export interface VoicePrefixGateProps {
  /** Called when the user completes or skips the voice prefix flow. */
  onDone: () => void;
}

const profilesClient = createVoiceProfilesClient(client);

export function VoicePrefixGate({
  onDone,
}: VoicePrefixGateProps): React.ReactElement {
  const [step, setStep] = React.useState<VoicePrefixStep>("welcome");
  const { defaults: voiceProviderDefaults } = useDefaultProviderPresets();
  const voiceConfig = React.useMemo(
    () => applyVoiceProviderDefaults(null, voiceProviderDefaults),
    [voiceProviderDefaults],
  );
  const voice = useVoiceChat({
    cloudConnected: false,
    interruptOnSpeech: false,
    lang: "en-US",
    onTranscript: () => {},
    voiceConfig,
  });

  const handleAdvance = React.useCallback(
    (next: VoicePrefixStep | null) => {
      if (next === null) {
        // Reached the end of the voice prefix.
        onDone();
        return;
      }
      setStep(next);
    },
    [onDone],
  );

  const handleBack = React.useCallback(() => {
    // On the first step, back is a no-op (there is no previous step).
    // The "Skip all" button handles exiting the flow without completing.
  }, []);

  const handleSkipPrefix = React.useCallback(() => {
    onDone();
  }, [onDone]);

  const handleRequestMicPermission = React.useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices)
      return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Release the stream immediately after permission is granted.
      for (const track of stream.getTracks()) {
        track.stop();
      }
      return true;
    } catch {
      return false;
    }
  }, []);

  return (
    <div
      data-testid="voice-prefix-gate"
      className="flex min-h-screen w-full items-center justify-center bg-bg p-6"
    >
      <div className="w-full max-w-xl rounded-sm border border-border/40 bg-card/60 p-8 shadow-sm">
        <VoicePrefixSteps
          step={step}
          tier={null}
          profilesClient={profilesClient}
          onAdvance={handleAdvance}
          onBack={handleBack}
          onSkipPrefix={handleSkipPrefix}
          onRequestMicPermission={handleRequestMicPermission}
          onAgentSpeak={voice.speak}
        />
      </div>
    </div>
  );
}

export default VoicePrefixGate;
