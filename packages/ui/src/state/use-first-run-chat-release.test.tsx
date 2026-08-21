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

function requireEpoch(epoch: number | null): number {
  if (epoch === null) throw new Error("Expected an active first-run epoch");
  return epoch;
}

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

    act(() =>
      result.current.recordMountedOverlay(
        requireEpoch(result.current.mountEpoch),
      ),
    );
    expect(result.current.mountedOnboarding).toBe(false);
    act(() =>
      result.current.recordMountedTranscript(
        requireEpoch(result.current.mountEpoch),
      ),
    );
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

    act(() =>
      result.current.recordMountedOverlay(
        requireEpoch(result.current.mountEpoch),
      ),
    );
    act(() =>
      result.current.recordMountedTranscript(
        requireEpoch(result.current.mountEpoch),
      ),
    );
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(true);

    rerender({ complete: false });
    expect(result.current.releasePending).toBe(false);
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(false);

    rerender({ complete: false });
    act(() =>
      result.current.recordMountedOverlay(
        requireEpoch(result.current.mountEpoch),
      ),
    );
    act(() =>
      result.current.recordMountedTranscript(
        requireEpoch(result.current.mountEpoch),
      ),
    );
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
    act(() =>
      result.current.recordMountedOverlay(
        requireEpoch(result.current.mountEpoch),
      ),
    );
    act(() =>
      result.current.recordMountedTranscript(
        requireEpoch(result.current.mountEpoch),
      ),
    );
    rerender({ complete: true, phase: "starting-runtime" });

    expect(result.current.releasePending).toBe(true);
  });

  it("retains polling mount evidence when first run becomes authoritative", () => {
    const { result, rerender } = renderHook(
      ({ complete, phase }: { complete: boolean; phase: StartupPhaseValue }) =>
        useFirstRunChatRelease(complete, phase),
      {
        initialProps: { complete: false, phase: "polling-backend" },
        wrapper: strictWrapper,
      },
    );

    const pollingEpoch = result.current.mountEpoch;
    expect(pollingEpoch).not.toBeNull();
    act(() => result.current.recordMountedOverlay(requireEpoch(pollingEpoch)));
    act(() =>
      result.current.recordMountedTranscript(requireEpoch(pollingEpoch)),
    );
    expect(result.current.mountedOnboarding).toBe(false);

    rerender({ complete: false, phase: "first-run-required" });
    expect(result.current.authorityEpoch).toBe(pollingEpoch);
    expect(result.current.mountedOnboarding).toBe(true);

    rerender({ complete: true, phase: "starting-runtime" });
    expect(result.current.releasePending).toBe(true);
  });
});
