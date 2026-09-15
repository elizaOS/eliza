/** Exercises action-feedback delivery races through the real lifecycle hook with simulated OS boundaries. */
// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { deliver } = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("../bridge/notification-delivery", () => ({
  deliverSystemNotification: deliver,
}));

import { useLifecycleState } from "./useLifecycleState";

beforeEach(() => {
  vi.useFakeTimers();
  deliver.mockReset();
});
afterEach(() => vi.useRealTimers());

it("uses native completion feedback without also displaying an app toast", async () => {
  deliver.mockResolvedValue("desktop");
  const { result } = renderHook(() => useLifecycleState());
  await act(async () => result.current.setActionNotice("Saved", "success"));
  expect(result.current.state.actionNotice).toBeNull();
  expect(deliver).toHaveBeenCalledWith(
    expect.objectContaining({
      body: "Saved",
      requestPermission: false,
    }),
  );
});

it("shows unavailable-native feedback for its full dwell, then dismisses it", async () => {
  deliver.mockResolvedValue("none");
  const { result } = renderHook(() => useLifecycleState());
  await act(async () =>
    result.current.setActionNotice("Could not save", "error", 5000),
  );
  expect(result.current.state.actionNotice?.text).toBe("Could not save");
  act(() => vi.advanceTimersByTime(4999));
  expect(result.current.state.actionNotice?.text).toBe("Could not save");
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.state.actionNotice).toBeNull();
});

it("does not let a late native failure replace newer live progress", async () => {
  let finish: (channel: string) => void = () => {
    throw new Error("not started");
  };
  deliver.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => useLifecycleState());
  act(() => result.current.setActionNotice("Old feedback"));
  act(() =>
    result.current.setActionNotice("Uploading", "info", 10000, false, true),
  );
  await act(async () => finish("none"));
  expect(result.current.state.actionNotice).toMatchObject({
    text: "Uploading",
    busy: true,
  });
  expect(deliver).toHaveBeenCalledTimes(1);
});

it("honors once before native dispatch", async () => {
  deliver.mockResolvedValue("local");
  const { result } = renderHook(() => useLifecycleState());
  await act(async () => {
    result.current.setActionNotice("Connected", "success", 2800, true);
    result.current.setActionNotice("Connected", "success", 2800, true);
  });
  expect(deliver).toHaveBeenCalledTimes(1);
});

it("dismisses pending feedback without resurrecting it when native delivery fails", async () => {
  let finish: (channel: string) => void = () => {
    throw new Error("not started");
  };
  deliver.mockImplementation(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => useLifecycleState());
  act(() => {
    const cancel = result.current.setActionNotice("Pending delivery");
    if (typeof cancel !== "function") throw new Error("Missing cancellation");
    cancel();
  });
  await act(async () => finish("none"));
  expect(result.current.state.actionNotice).toBeNull();
});
