/**
 * Verifies the first-run finalizer hands the persisted runtime topology to the
 * startup coordinator before the app leaves onboarding.
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { savePersistedActiveServer } from "./persistence";
import {
  type FirstRunCallbacksDeps,
  useFirstRunCallbacks,
} from "./useFirstRunCallbacks";

describe("useFirstRunCallbacks", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("completes a fresh Cloud onboarding with the cloud-managed target", () => {
    savePersistedActiveServer({
      id: "cloud:agent-1",
      kind: "cloud",
      label: "Eliza Cloud",
      apiBase: "https://elizacloud.ai/api/v1/eliza/agents/agent-1",
      accessToken: "test-token",
    });
    const coordinatorComplete = vi.fn();
    const completionCommittedRef = { current: false };
    const setFirstRunComplete = vi.fn();
    const setTab = vi.fn();
    const loadCharacter = vi.fn(async () => undefined);
    const deps: FirstRunCallbacksDeps = {
      firstRun: {
        completionCommittedRef,
      } as FirstRunCallbacksDeps["firstRun"],
      setPostFirstRunChecklistDismissed: vi.fn(),
      setFirstRunComplete,
      coordinatorFirstRunCompleteRef: { current: coordinatorComplete },
      initialTabSetRef: { current: false },
      setTab,
      defaultLandingTab: "home",
      loadCharacter,
    };
    const { result } = renderHook(() => useFirstRunCallbacks(deps));

    act(() => result.current.completeFirstRun("chat"));

    expect(completionCommittedRef.current).toBe(true);
    expect(setFirstRunComplete).toHaveBeenCalledWith(true);
    expect(coordinatorComplete).toHaveBeenCalledWith("cloud-managed");
    expect(setTab).toHaveBeenCalledWith("chat");
    expect(loadCharacter).toHaveBeenCalledOnce();
  });
});
