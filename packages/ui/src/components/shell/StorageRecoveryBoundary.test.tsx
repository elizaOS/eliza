/** Exercises the real recovery boundary and controls; the storage-owner availability signal and IPC completion are deterministic collaborators. */
// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storage = vi.hoisted(() => ({
  required: false,
  listeners: new Set<() => void>(),
  retry: vi.fn(async (): Promise<void> => undefined),
}));
vi.mock("../../bridge/storage-bridge", () => ({
  initializeStorageBridge: storage.retry,
  isStorageRecoveryRequired: () => storage.required,
  subscribeStorageRecovery: (listener: () => void) => {
    storage.listeners.add(listener);
    return () => storage.listeners.delete(listener);
  },
}));

import { StorageRecoveryBoundary } from "./StorageRecoveryBoundary";

function availability(required: boolean) {
  storage.required = required;
  for (const listener of storage.listeners) listener();
}
beforeEach(() => {
  storage.required = false;
  storage.retry.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  storage.listeners.clear();
});

describe("protected session recovery surface", () => {
  it("mounts healthy children without storage retry or authentication", () => {
    render(
      <StorageRecoveryBoundary>
        <p>Session consumer</p>
      </StorageRecoveryBoundary>,
    );
    expect(screen.getByText("Session consumer")).toBeTruthy();
    expect(storage.retry).not.toHaveBeenCalled();
  });

  it("keeps children unmounted until the owned retry settles, coalescing double clicks", async () => {
    storage.required = true;
    let finish!: () => void;
    storage.retry.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const mounted = vi.fn();
    function Session() {
      useEffect(mounted, []);
      return <p>Session consumer</p>;
    }
    render(
      <StorageRecoveryBoundary>
        <Session />
      </StorageRecoveryBoundary>,
    );
    expect(mounted).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("heading"));
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(storage.retry).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain("Checking");
    act(() => availability(false));
    expect(mounted).not.toHaveBeenCalled();
    await act(async () => {
      finish();
    });
    expect(mounted).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("keeps a failed retry actionable without exposing private failure details", async () => {
    storage.required = true;
    storage.retry.mockRejectedValueOnce(new Error("private-native-value"));
    render(
      <StorageRecoveryBoundary>
        <p>Session consumer</p>
      </StorageRecoveryBoundary>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.queryByText("Session consumer")).toBeNull();
    expect(document.body.textContent).not.toContain("private-native-value");
    expect(screen.getByRole("status").textContent).toContain(
      "still unavailable",
    );
    expect(
      (screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    storage.retry.mockImplementationOnce(async () => {
      availability(false);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    });
    expect(screen.getByText("Session consumer")).toBeTruthy();
  });

  it("stops mounted session consumers when the storage owner reports a settled failure", () => {
    const stop = vi.fn();
    function Session() {
      useEffect(() => stop, []);
      return <p>Session consumer</p>;
    }
    render(
      <StorageRecoveryBoundary>
        <Session />
      </StorageRecoveryBoundary>,
    );
    act(() => availability(true));
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.queryByText("Session consumer")).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(storage.retry).not.toHaveBeenCalled();
  });
});
