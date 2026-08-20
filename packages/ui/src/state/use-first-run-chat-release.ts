/**
 * Owns committed first-run chat release state above overlay remounts. Lifecycle
 * transitions run in layout effects or event callbacks so an interrupted React
 * render cannot manufacture, consume, or reset a FULL-detent release.
 */

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  acknowledgeFirstRunChatRelease,
  createFirstRunChatReleaseState,
  observeFirstRunCompletion,
  recordMountedFirstRunOverlay,
  recordMountedFirstRunTranscript,
} from "./first-run-chat-release";
import type { StartupPhaseValue } from "./startup-coordinator";

export interface FirstRunChatReleaseController {
  releasePending: boolean;
  mountedOnboarding: boolean;
  recordMountedOverlay: () => void;
  recordMountedTranscript: () => void;
  acknowledgeRelease: () => void;
}

export function useFirstRunChatRelease(
  firstRunComplete: boolean | null,
  startupPhase: StartupPhaseValue,
): FirstRunChatReleaseController {
  const lifecycleRef = useRef(
    createFirstRunChatReleaseState(firstRunComplete, startupPhase),
  );
  const [releasePending, setReleasePending] = useState(false);
  const [mountedOnboarding, setMountedOnboarding] = useState(false);

  const syncMountedOnboarding = useCallback(() => {
    const lifecycle = lifecycleRef.current;
    setMountedOnboarding(
      lifecycle.observedIncomplete &&
        lifecycle.overlayMountedWhileIncomplete &&
        lifecycle.transcriptMountedWhileIncomplete,
    );
  }, []);

  useLayoutEffect(() => {
    lifecycleRef.current = observeFirstRunCompletion(
      lifecycleRef.current,
      firstRunComplete,
      startupPhase,
    );
    setReleasePending(lifecycleRef.current.releasePending);
    syncMountedOnboarding();
  }, [firstRunComplete, startupPhase, syncMountedOnboarding]);

  const recordMountedOverlay = useCallback(() => {
    lifecycleRef.current = observeFirstRunCompletion(
      lifecycleRef.current,
      firstRunComplete,
      startupPhase,
    );
    lifecycleRef.current = recordMountedFirstRunOverlay(lifecycleRef.current);
    syncMountedOnboarding();
  }, [firstRunComplete, startupPhase, syncMountedOnboarding]);

  const recordMountedTranscript = useCallback(() => {
    lifecycleRef.current = observeFirstRunCompletion(
      lifecycleRef.current,
      firstRunComplete,
      startupPhase,
    );
    lifecycleRef.current = recordMountedFirstRunTranscript(
      lifecycleRef.current,
    );
    syncMountedOnboarding();
  }, [firstRunComplete, startupPhase, syncMountedOnboarding]);

  const acknowledgeRelease = useCallback(() => {
    lifecycleRef.current = acknowledgeFirstRunChatRelease(lifecycleRef.current);
    setReleasePending(lifecycleRef.current.releasePending);
  }, []);

  return {
    releasePending,
    mountedOnboarding,
    recordMountedOverlay,
    recordMountedTranscript,
    acknowledgeRelease,
  };
}
