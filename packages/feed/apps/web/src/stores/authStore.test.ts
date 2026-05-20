import { afterEach, describe, expect, it } from "bun:test";

const originalWindow = globalThis.window;

function setWindow(windowValue: unknown) {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowValue,
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("authStore safe persistence", () => {
  it("keeps the store usable when localStorage access throws", async () => {
    const throwingWindow = {};

    Object.defineProperty(throwingWindow, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });

    setWindow(throwingWindow);

    const { useAuthStore } = await import("./authStore");

    expect(() =>
      useAuthStore.getState().setUser({ id: "user-1", displayName: "User 1" }),
    ).not.toThrow();
    expect(useAuthStore.getState().user).toEqual({
      id: "user-1",
      displayName: "User 1",
    });

    expect(() => useAuthStore.getState().clearAuth()).not.toThrow();
    expect(useAuthStore.getState().user).toBeNull();
  });
});
