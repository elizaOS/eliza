import * as React from "react";
import { VoicePill } from "../components/voice-pill";
import { useFirstRunController } from "./use-first-run-controller";

/**
 * Standalone voice pill for the onboarding overlay — fixed to the
 * bottom-center of the viewport, completely independent of the
 * CompactOnboarding notification card.
 *
 * Shares the same `useFirstRunController` context so spoken
 * "local" / "cloud" commands drive the same first-run flow.
 */
export function OnboardingVoicePill(): React.ReactElement {
  const c = useFirstRunController();
  const { voice, cloudOnly } = c;

  // Start voice capture on mount (same as CompactOnboarding).
  // biome-ignore lint/correctness/useExhaustiveDependencies: start once on mount.
  React.useEffect(() => {
    if (voice.supported && !cloudOnly) {
      void c.startVoice().catch(() => {});
    }
    return () => {
      void c.stopVoice().catch(() => {});
    };
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 flex justify-center pb-8">
      <div className="pointer-events-auto">
        <VoicePill
          ariaLabel="Eliza"
          recording={voice.listening}
          onRecordingChange={(recording) => {
            if (recording) void c.startVoice().catch(() => {});
            else void c.stopVoice().catch(() => {});
          }}
        />
      </div>
    </div>
  );
}
