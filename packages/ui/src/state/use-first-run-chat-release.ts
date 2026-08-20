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
  recordMountedFirstRunChat,
} from "./first-run-chat-release";

export interface FirstRunChatReleaseController {
  releasePending: boolean;
  recordMountedChat: () => void;
  acknowledgeRelease: () => void;
}

export function useFirstRunChatRelease(
  firstRunComplete: boolean | null,
): FirstRunChatReleaseController {
  const lifecycleRef = useRef(createFirstRunChatReleaseState(firstRunComplete));
  const [releasePending, setReleasePending] = useState(false);

  useLayoutEffect(() => {
    lifecycleRef.current = observeFirstRunCompletion(
      lifecycleRef.current,
      firstRunComplete,
    );
    setReleasePending(lifecycleRef.current.releasePending);
  }, [firstRunComplete]);

  const recordMountedChat = useCallback(() => {
    lifecycleRef.current = recordMountedFirstRunChat(lifecycleRef.current);
  }, []);

  const acknowledgeRelease = useCallback(() => {
    lifecycleRef.current = acknowledgeFirstRunChatRelease(lifecycleRef.current);
    setReleasePending(lifecycleRef.current.releasePending);
  }, []);

  return { releasePending, recordMountedChat, acknowledgeRelease };
}
