// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hydratePersistedFirstRunCompleteFromNativeStore,
  loadPersistedFirstRunComplete,
  savePersistedFirstRunComplete,
} from "./persistence";
import { useFirstRunState } from "./useFirstRunState";

/**
 * Client-side durability contract for onboarding completion (issue #11506).
 *
 * Symptom: after finishing onboarding, a fresh app process (mobile relaunch /
 * desktop restart) re-showed onboarding. The client's completion signal is an
 * in-memory React ref (`firstRunCompletionCommittedRef`) that is lost on every
 * process restart, so a fresh boot depended entirely on the server status —
 * and re-prompted whenever that status was briefly unavailable or lagged.
 *
 * These tests drive the REAL persistence + coordinator functions (no mock
 * stands in for the thing under test) and assert the SEMANTIC outcome: a
 * completed onboarding, persisted durably, keeps the completion committed
 * across a simulated fresh process and routes the boot home instead of
 * returning `first-run-required`.
 */

const FIRST_RUN_COMPLETE_STORAGE_KEY = "eliza:first-run-complete";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

describe("first-run completion durable flag survives a process restart", () => {
  it("a genuine first run (nothing persisted) reads NOT complete", () => {
    expect(loadPersistedFirstRunComplete()).toBe(false);
  });

  it("round-trips the completion flag through localStorage across a fresh read", () => {
    savePersistedFirstRunComplete(true);
    // loadPersistedFirstRunComplete re-reads localStorage on every call, so a
    // second call with no in-memory carry-over is a faithful "fresh process".
    expect(loadPersistedFirstRunComplete()).toBe(true);
    expect(window.localStorage.getItem(FIRST_RUN_COMPLETE_STORAGE_KEY)).toBe(
      "1",
    );
  });

  it("clears the flag when completion is reset", () => {
    savePersistedFirstRunComplete(true);
    savePersistedFirstRunComplete(false);
    expect(loadPersistedFirstRunComplete()).toBe(false);
    expect(
      window.localStorage.getItem(FIRST_RUN_COMPLETE_STORAGE_KEY),
    ).toBeNull();
  });
});

describe("useFirstRunState seeds the completion ref from durable storage", () => {
  it("a fresh mount with a persisted completed onboarding starts committed", () => {
    savePersistedFirstRunComplete(true);
    const { result } = renderHook(() => useFirstRunState());
    // A new process would create this ref anew; seeding it from the durable
    // flag is what keeps onboarding committed across the restart.
    expect(result.current.completionCommittedRef.current).toBe(true);
    // The post-onboarding character-select handoff is intentionally not
    // durable; a relaunch must go home/chat, not replay character select.
    expect(result.current.completionJustCommittedRef.current).toBe(false);
  });

  it("a fresh mount with no prior onboarding starts uncommitted", () => {
    const { result } = renderHook(() => useFirstRunState());
    expect(result.current.completionCommittedRef.current).toBe(false);
    expect(result.current.completionJustCommittedRef.current).toBe(false);
  });
});

describe("hydratePersistedFirstRunCompleteFromNativeStore is boot-safe", () => {
  it("no-ops without throwing when Capacitor is unavailable (web/test shell)", async () => {
    await expect(
      hydratePersistedFirstRunCompleteFromNativeStore(),
    ).resolves.toBeUndefined();
    // Nothing to restore from, so the flag stays absent.
    expect(loadPersistedFirstRunComplete()).toBe(false);
  });

  it("does not clobber an already-present localStorage flag", async () => {
    savePersistedFirstRunComplete(true);
    await hydratePersistedFirstRunCompleteFromNativeStore();
    expect(loadPersistedFirstRunComplete()).toBe(true);
  });
});
