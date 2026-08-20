/**
 * Pure lifecycle regressions for retaining a full-detent release only after a
 * real first-run chat mount, including the overlay-remount handoff.
 */

import { describe, expect, it } from "vitest";
import {
  acknowledgeFirstRunChatRelease,
  createFirstRunChatReleaseState,
  observeFirstRunCompletion,
  recordMountedFirstRunOverlay,
  recordMountedFirstRunTranscript,
} from "./first-run-chat-release";

describe("first-run chat release tracking", () => {
  it("ignores a completed-user startup probe transition without a mounted chat", () => {
    let state = createFirstRunChatReleaseState(false, "ready");
    state = recordMountedFirstRunOverlay(state);
    state = recordMountedFirstRunTranscript(state);
    state = observeFirstRunCompletion(state, true, "ready");

    expect(state).toEqual({
      observedIncomplete: false,
      overlayMountedWhileIncomplete: false,
      transcriptMountedWhileIncomplete: false,
      releasePending: false,
    });
  });

  it("retains a genuine mounted first-run completion across an overlay remount", () => {
    let state = createFirstRunChatReleaseState(false, "first-run-required");
    state = recordMountedFirstRunOverlay(state);
    state = recordMountedFirstRunTranscript(state);
    state = observeFirstRunCompletion(state, true, "starting-runtime");

    expect(state.releasePending).toBe(true);
    state = acknowledgeFirstRunChatRelease(state);
    expect(state.releasePending).toBe(false);
  });

  it("does not let a mount outside first run authorize a later release", () => {
    let state = createFirstRunChatReleaseState(true, "ready");
    state = recordMountedFirstRunOverlay(state);
    state = recordMountedFirstRunTranscript(state);
    state = observeFirstRunCompletion(state, false, "ready");
    state = observeFirstRunCompletion(state, true, "ready");

    expect(state.releasePending).toBe(false);
  });

  it("cancels a stale unacknowledged release when first run restarts", () => {
    let state = createFirstRunChatReleaseState(false, "first-run-required");
    state = recordMountedFirstRunOverlay(state);
    state = recordMountedFirstRunTranscript(state);
    state = observeFirstRunCompletion(state, true, "ready");
    expect(state.releasePending).toBe(true);

    state = observeFirstRunCompletion(state, false, "first-run-required");
    expect(state).toEqual({
      observedIncomplete: true,
      overlayMountedWhileIncomplete: false,
      transcriptMountedWhileIncomplete: false,
      releasePending: false,
    });

    state = observeFirstRunCompletion(state, true, "ready");
    expect(state.releasePending).toBe(false);
  });

  it("retains a mounted epoch across an unresolved probe", () => {
    let state = createFirstRunChatReleaseState(false, "first-run-required");
    state = recordMountedFirstRunOverlay(state);
    state = recordMountedFirstRunTranscript(state);
    state = observeFirstRunCompletion(state, null, "polling-backend");
    state = observeFirstRunCompletion(state, true, "ready");

    expect(state.releasePending).toBe(true);
  });

  it("requires both the committed overlay and a real first-run transcript", () => {
    const overlayOnly = observeFirstRunCompletion(
      recordMountedFirstRunOverlay(
        createFirstRunChatReleaseState(false, "first-run-required"),
      ),
      true,
      "ready",
    );
    const transcriptOnly = observeFirstRunCompletion(
      recordMountedFirstRunTranscript(
        createFirstRunChatReleaseState(false, "first-run-required"),
      ),
      true,
      "ready",
    );

    expect(overlayOnly.releasePending).toBe(false);
    expect(transcriptOnly.releasePending).toBe(false);
  });
});
