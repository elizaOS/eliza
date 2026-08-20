/** Verifies committed React lifecycle ownership of first-run chat releases. */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { describe, expect, it } from "vitest";
import type { StartupPhaseValue } from "./startup-coordinator";
import { useFirstRunChatRelease } from "./use-first-run-chat-release";

const strictWrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>{children}</StrictMode>
);

describe("useFirstRunChatRelease", () => {
  it("does not release for an unmounted startup-probe transition", () => {
    const { result, rerender } = renderHook(
      ({ complete }: { complete: boolean | null }) =>
        useFirstRunChatRelease(complete, "ready"),
      { initialProps: { complete: false }, wrapper: strictWrapper },
    );

    rerender({ complete: true });
    expect(result.current.releasePending).toBe(false);
  });

  it("retains one mounted completion across overlay remount and acknowledgement", () => {
    const { result, rerender } = renderHook(
      ({ complete }: { complete: boolean | null }) =>
        useFirstRunChatRelease(complete, "first-run-required"),
      { initialProps: { complete: false }, wrapper: strictWrapper },
    );

    act(() => result.current.recordMountedOverlay());
    expect(result.current.mountedOnboarding).toBe(false);
    act(() => result.current.recordMountedTranscript());
    expect(result.current.mountedOnboarding).toBe(true);
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(true);
    expect(result.current.mountedOnboarding).toBe(false);

    act(() => result.current.acknowledgeRelease());
    expect(result.current.releasePending).toBe(false);
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(false);
  });

  it("requires a new mounted chat after reset cancels a pending release", () => {
    const { result, rerender } = renderHook(
      ({ complete }: { complete: boolean | null }) =>
        useFirstRunChatRelease(complete, "first-run-required"),
      { initialProps: { complete: false }, wrapper: strictWrapper },
    );

    act(() => result.current.recordMountedOverlay());
    act(() => result.current.recordMountedTranscript());
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(true);

    rerender({ complete: false });
    expect(result.current.releasePending).toBe(false);
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(false);

    rerender({ complete: false });
    act(() => result.current.recordMountedOverlay());
    act(() => result.current.recordMountedTranscript());
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(true);
  });

  it("arms when the coordinator authoritatively enters first run after a false probe", () => {
    const initialProps: {
      complete: boolean | null;
      phase: StartupPhaseValue;
    } = { complete: false, phase: "ready" };
    const { result, rerender } = renderHook(
      ({
        complete,
        phase,
      }: {
        complete: boolean | null;
        phase: StartupPhaseValue;
      }) => useFirstRunChatRelease(complete, phase),
      {
        initialProps,
        wrapper: strictWrapper,
      },
    );

    rerender({ complete: false, phase: "first-run-required" });
    act(() => result.current.recordMountedOverlay());
    act(() => result.current.recordMountedTranscript());
    rerender({ complete: true, phase: "starting-runtime" });

    expect(result.current.releasePending).toBe(true);
  });
});
