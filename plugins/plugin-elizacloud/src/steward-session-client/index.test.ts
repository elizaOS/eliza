/** Owns cancellation and session comparison in the real canonical mutation queue. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readStoredStewardToken,
  registerStewardTokenPersistence,
  registerStewardTokenRemoval,
  replaceStoredStewardTokenIfCurrent,
  STEWARD_ACTIVE_SCOPE_KEY,
  STEWARD_SESSION_CHANGE_EVENT,
  STEWARD_TOKEN_KEY,
  STEWARD_TOKEN_SCOPE_KEY,
  writeStoredStewardToken,
} from "./index";

afterEach(() => {
  localStorage.clear();
});
describe("owned phone session publication", () => {
  it("does not execute an owned write cancelled while queued", async () => {
    await writeStoredStewardToken("owner-token");
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persist = vi.fn(async (token: string) => {
      started();
      await held;
      localStorage.setItem(STEWARD_TOKEN_KEY, token);
    });
    const unregister = registerStewardTokenPersistence(persist);
    try {
      const blocking = writeStoredStewardToken("owner-token");
      await entered;
      const controller = new AbortController();
      const candidate = replaceStoredStewardTokenIfCurrent(
        "owner-token",
        "cancelled-token",
        { signal: controller.signal },
      );
      controller.abort();
      release();
      await blocking;
      expect(await candidate).toBe(false);
      expect(persist).toHaveBeenCalledTimes(1);
      expect(readStoredStewardToken()).toBe("owner-token");
    } finally {
      release();
      unregister();
    }
  });

  it("compares a nullable initial owner inside the queue after a newer sign-in", async () => {
    const newer = writeStoredStewardToken("newer-token");
    const candidate = replaceStoredStewardTokenIfCurrent(
      null,
      "old-phone-token",
      { signal: new AbortController().signal },
    );
    await newer;
    expect(await candidate).toBe(false);
    expect(readStoredStewardToken()).toBe("newer-token");
  });

  it("admits an owned phone publication from an empty session", async () => {
    expect(
      await replaceStoredStewardTokenIfCurrent(null, "phone-token", {
        signal: new AbortController().signal,
      }),
    ).toBe(true);
    expect(readStoredStewardToken()).toBe("phone-token");
  });
});

// Actual registered durable boundary: cancellation lands after the write starts.
it.each([null, "owner-token"])(
  "compensates cancellation during durable persistence from %s",
  async (initial) => {
    if (initial) await writeStoredStewardToken(initial);
    let durable: string | null = initial;
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unregister = registerStewardTokenPersistence(async (token) => {
      if (token === "cancelled-token") {
        entered();
        await held;
      }
      durable = token;
      localStorage.setItem(STEWARD_TOKEN_KEY, token);
    });
    const unregisterRemoval = registerStewardTokenRemoval(async () => {
      durable = null;
      localStorage.removeItem(STEWARD_TOKEN_KEY);
    });
    const changed = vi.fn();
    const beforePublish = vi.fn();
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, changed);
    try {
      const controller = new AbortController();
      const candidate = replaceStoredStewardTokenIfCurrent(
        initial,
        "cancelled-token",
        { signal: controller.signal, beforePublish },
      );
      await started;
      controller.abort();
      release();
      expect(await candidate).toBe(false);
      expect(readStoredStewardToken()).toBe(initial);
      expect(durable).toBe(initial);
      expect(beforePublish).not.toHaveBeenCalled();
      expect(changed).not.toHaveBeenCalled();
    } finally {
      release();
      unregister();
      unregisterRemoval();
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, changed);
    }
  },
);

it.each([
  "queued-newer",
  "external-newer",
  "scoped-external-newer",
  "other-scope",
])(
  "preserves %s authority around cancelled durable persistence",
  async (mode) => {
    localStorage.setItem(STEWARD_TOKEN_KEY, "prior-token");
    if (mode === "other-scope") {
      localStorage.setItem(STEWARD_TOKEN_SCOPE_KEY, "prior-scope");
      localStorage.setItem(STEWARD_ACTIVE_SCOPE_KEY, "active-scope");
    }
    if (mode === "scoped-external-newer") {
      localStorage.setItem(STEWARD_TOKEN_SCOPE_KEY, "active-scope");
      localStorage.setItem(STEWARD_ACTIVE_SCOPE_KEY, "active-scope");
    }
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unregister = registerStewardTokenPersistence(async (token) => {
      localStorage.setItem(STEWARD_TOKEN_KEY, token);
      if (token === "cancelled-token") {
        entered();
        await held;
      }
    });
    try {
      const controller = new AbortController();
      const candidate = replaceStoredStewardTokenIfCurrent(
        mode === "other-scope" ? null : "prior-token",
        "cancelled-token",
        { signal: controller.signal },
      );
      await started;
      const newer =
        mode === "queued-newer" ? writeStoredStewardToken("newer-token") : null;
      if (mode === "external-newer" || mode === "scoped-external-newer")
        localStorage.setItem(STEWARD_TOKEN_KEY, "newer-token");
      if (mode === "scoped-external-newer") {
        localStorage.setItem(STEWARD_TOKEN_SCOPE_KEY, "newer-scope");
        localStorage.setItem(STEWARD_ACTIVE_SCOPE_KEY, "newer-scope");
      }
      controller.abort();
      release();
      expect(await candidate).toBe(false);
      if (newer) await newer;
      expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBe(
        mode === "other-scope" ? "prior-token" : "newer-token",
      );
      if (mode === "scoped-external-newer") {
        expect(localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY)).toBe(
          "newer-scope",
        );
        expect(readStoredStewardToken()).toBe("newer-token");
      }
      if (mode === "other-scope") {
        expect(localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY)).toBe(
          "prior-scope",
        );
        expect(readStoredStewardToken()).toBeNull();
      }
    } finally {
      release();
      unregister();
    }
  },
);

it.each([null, "owner-token"])(
  "preserves a newer external scope during rollback to %s",
  async (initial) => {
    if (initial) localStorage.setItem(STEWARD_TOKEN_KEY, initial);
    localStorage.setItem(STEWARD_TOKEN_SCOPE_KEY, "initial-scope");
    localStorage.setItem(STEWARD_ACTIVE_SCOPE_KEY, "initial-scope");
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const unregister = registerStewardTokenPersistence(async (token) => {
      if (token === "cancelled-token") {
        localStorage.setItem(STEWARD_TOKEN_KEY, token);
        controller.abort();
      } else {
        entered();
        await held;
      }
    });
    const unregisterRemoval = registerStewardTokenRemoval(async () => {
      entered();
      await held;
    });
    try {
      const candidate = replaceStoredStewardTokenIfCurrent(
        initial,
        "cancelled-token",
        { signal: controller.signal },
      );
      await started;
      localStorage.setItem(STEWARD_TOKEN_KEY, "newer-token");
      localStorage.setItem(STEWARD_TOKEN_SCOPE_KEY, "newer-scope");
      localStorage.setItem(STEWARD_ACTIVE_SCOPE_KEY, "newer-scope");
      release();
      expect(await candidate).toBe(false);
      expect(localStorage.getItem(STEWARD_TOKEN_SCOPE_KEY)).toBe("newer-scope");
      expect(readStoredStewardToken()).toBe("newer-token");
    } finally {
      release();
      unregister();
      unregisterRemoval();
    }
  },
);
