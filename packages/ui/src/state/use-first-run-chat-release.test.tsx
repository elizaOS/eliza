/** Verifies committed React lifecycle ownership of first-run chat releases. */
// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { describe, expect, it } from "vitest";
import { useFirstRunChatRelease } from "./use-first-run-chat-release";

const strictWrapper = ({ children }: { children: ReactNode }) => (
  <StrictMode>{children}</StrictMode>
);

describe("useFirstRunChatRelease", () => {
  it("does not release for an unmounted startup-probe transition", () => {
    const { result, rerender } = renderHook(
      ({ complete }: { complete: boolean | null }) =>
        useFirstRunChatRelease(complete),
      { initialProps: { complete: false }, wrapper: strictWrapper },
    );

    rerender({ complete: true });
    expect(result.current.releasePending).toBe(false);
  });

  it("retains one mounted completion across overlay remount and acknowledgement", () => {
    const { result, rerender } = renderHook(
      ({ complete }: { complete: boolean | null }) =>
        useFirstRunChatRelease(complete),
      { initialProps: { complete: false }, wrapper: strictWrapper },
    );

    act(() => result.current.recordMountedChat());
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(true);

    act(() => result.current.acknowledgeRelease());
    expect(result.current.releasePending).toBe(false);
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(false);
  });

  it("requires a new mounted chat after reset cancels a pending release", () => {
    const { result, rerender } = renderHook(
      ({ complete }: { complete: boolean | null }) =>
        useFirstRunChatRelease(complete),
      { initialProps: { complete: false }, wrapper: strictWrapper },
    );

    act(() => result.current.recordMountedChat());
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(true);

    rerender({ complete: false });
    expect(result.current.releasePending).toBe(false);
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(false);

    rerender({ complete: false });
    act(() => result.current.recordMountedChat());
    rerender({ complete: true });
    expect(result.current.releasePending).toBe(true);
  });
});
