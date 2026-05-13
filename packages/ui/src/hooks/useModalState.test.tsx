// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useModalState } from "./useModalState";

describe("useModalState", () => {
  it("starts in closed state", () => {
    const { result } = renderHook(() => useModalState());
    expect(result.current.state).toEqual({ status: "closed" });
  });

  it("open() transitions to open", () => {
    const { result } = renderHook(() => useModalState());
    act(() => {
      result.current.open();
    });
    expect(result.current.state).toEqual({ status: "open" });
  });

  it("submit() success closes the modal and returns the result", async () => {
    const { result } = renderHook(() => useModalState());
    act(() => {
      result.current.open();
    });

    let returned: string | undefined;
    await act(async () => {
      returned = await result.current.submit(async () => "ok");
    });
    expect(returned).toBe("ok");
    expect(result.current.state).toEqual({ status: "closed" });
  });

  it("submit() error transitions to error state and returns undefined", async () => {
    const { result } = renderHook(() => useModalState());
    act(() => {
      result.current.open();
    });

    const boom = new Error("boom");
    let returned: unknown = "untouched";
    await act(async () => {
      returned = await result.current.submit(async () => {
        throw boom;
      });
    });

    expect(returned).toBeUndefined();
    expect(result.current.state).toEqual({ status: "error", error: boom });
  });

  it("submit() sets submitting state during the call", async () => {
    const { result } = renderHook(() => useModalState());
    let resolveFn: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => {
      resolveFn = resolve;
    });

    let submission: Promise<undefined> | null = null;
    await act(async () => {
      submission = result.current.submit(async () => {
        await pending;
        return undefined;
      });
      // Yield once so the state setter inside submit can flush.
      await Promise.resolve();
    });

    expect(result.current.state).toEqual({ status: "submitting" });

    await act(async () => {
      resolveFn?.();
      await submission;
    });
    expect(result.current.state).toEqual({ status: "closed" });
  });

  it("close() clears error state", async () => {
    const { result } = renderHook(() => useModalState());
    await act(async () => {
      await result.current.submit(async () => {
        throw new Error("fail");
      });
    });
    expect(result.current.state.status).toBe("error");

    act(() => {
      result.current.close();
    });
    expect(result.current.state).toEqual({ status: "closed" });
  });
});
