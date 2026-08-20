/**
 * Pure lifecycle regressions for retaining a full-detent release only after a
 * real first-run chat mount, including the overlay-remount handoff.
 */

import { describe, expect, it } from "vitest";
import {
  acknowledgeFirstRunChatRelease,
  createFirstRunChatReleaseState,
  observeFirstRunCompletion,
  recordMountedFirstRunChat,
} from "./first-run-chat-release";

describe("first-run chat release tracking", () => {
  it("ignores a completed-user startup probe transition without a mounted chat", () => {
    let state = createFirstRunChatReleaseState(false);
    state = observeFirstRunCompletion(state, true);

    expect(state).toEqual({
      observedIncomplete: false,
      mountedWhileIncomplete: false,
      releasePending: false,
    });
  });

  it("retains a genuine mounted first-run completion across an overlay remount", () => {
    let state = createFirstRunChatReleaseState(false);
    state = recordMountedFirstRunChat(state);
    state = observeFirstRunCompletion(state, true);

    expect(state.releasePending).toBe(true);
    state = acknowledgeFirstRunChatRelease(state);
    expect(state.releasePending).toBe(false);
  });

  it("does not let a mount outside first run authorize a later release", () => {
    let state = createFirstRunChatReleaseState(true);
    state = recordMountedFirstRunChat(state);
    state = observeFirstRunCompletion(state, false);
    state = observeFirstRunCompletion(state, true);

    expect(state.releasePending).toBe(false);
  });

  it("cancels a stale unacknowledged release when first run restarts", () => {
    let state = createFirstRunChatReleaseState(false);
    state = recordMountedFirstRunChat(state);
    state = observeFirstRunCompletion(state, true);
    expect(state.releasePending).toBe(true);

    state = observeFirstRunCompletion(state, false);
    expect(state).toEqual({
      observedIncomplete: true,
      mountedWhileIncomplete: false,
      releasePending: false,
    });

    state = observeFirstRunCompletion(state, true);
    expect(state.releasePending).toBe(false);
  });

  it("retains a mounted epoch across an unresolved probe", () => {
    let state = createFirstRunChatReleaseState(false);
    state = recordMountedFirstRunChat(state);
    state = observeFirstRunCompletion(state, null);
    state = observeFirstRunCompletion(state, true);

    expect(state.releasePending).toBe(true);
  });
});
