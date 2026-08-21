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
  mountEpoch: number | null;
  authorityEpoch: number | null;
  recordMountedOverlay: (epoch: number) => void;
  recordMountedTranscript: (epoch: number) => void;
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
  const [mountEpoch, setMountEpoch] = useState<number | null>(
    lifecycleRef.current.incompleteActive
      ? lifecycleRef.current.incompleteEpoch
      : null,
  );
  const [authorityEpoch, setAuthorityEpoch] = useState<number | null>(
    lifecycleRef.current.authoritativeEpoch,
  );

  const syncMountedOnboarding = useCallback(() => {
    const lifecycle = lifecycleRef.current;
    setMountedOnboarding(
      lifecycle.authoritativeEpoch === lifecycle.incompleteEpoch &&
        lifecycle.overlayMountedEpoch === lifecycle.incompleteEpoch &&
        lifecycle.transcriptMountedEpoch === lifecycle.incompleteEpoch,
    );
    setMountEpoch(
      lifecycle.incompleteActive ? lifecycle.incompleteEpoch : null,
    );
    setAuthorityEpoch(lifecycle.authoritativeEpoch);
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

  const recordMountedOverlay = useCallback(
    (epoch: number) => {
      lifecycleRef.current = observeFirstRunCompletion(
        lifecycleRef.current,
        firstRunComplete,
        startupPhase,
      );
      lifecycleRef.current = recordMountedFirstRunOverlay(
        lifecycleRef.current,
        epoch,
      );
      syncMountedOnboarding();
    },
    [firstRunComplete, startupPhase, syncMountedOnboarding],
  );

  const recordMountedTranscript = useCallback(
    (epoch: number) => {
      lifecycleRef.current = observeFirstRunCompletion(
        lifecycleRef.current,
        firstRunComplete,
        startupPhase,
      );
      lifecycleRef.current = recordMountedFirstRunTranscript(
        lifecycleRef.current,
        epoch,
      );
      syncMountedOnboarding();
    },
    [firstRunComplete, startupPhase, syncMountedOnboarding],
  );

  const acknowledgeRelease = useCallback(() => {
    lifecycleRef.current = acknowledgeFirstRunChatRelease(lifecycleRef.current);
    setReleasePending(lifecycleRef.current.releasePending);
  }, []);

  return {
    releasePending,
    mountedOnboarding,
    mountEpoch,
    authorityEpoch,
    recordMountedOverlay,
    recordMountedTranscript,
    acknowledgeRelease,
  };
}
