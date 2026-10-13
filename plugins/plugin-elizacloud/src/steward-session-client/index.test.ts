/** Owns cancellation and session comparison in the real canonical mutation queue. */
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readStoredStewardToken,
  registerStewardTokenPersistence,
  replaceStoredStewardTokenIfCurrent,
  STEWARD_TOKEN_KEY,
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

  it("restores the previous owner when cancelled during durable persistence", async () => {
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
      if (token === "cancelled-token") {
        started();
        await held;
      }
      window.localStorage.setItem(STEWARD_TOKEN_KEY, token);
    });
    const unregister = registerStewardTokenPersistence(persist);
    try {
      const controller = new AbortController();
      const beforePublish = vi.fn();
      const candidate = replaceStoredStewardTokenIfCurrent(
        "owner-token",
        "cancelled-token",
        { signal: controller.signal, beforePublish },
      );
      await entered;
      controller.abort();
      release();

      expect(await candidate).toBe(false);
      expect(persist).toHaveBeenNthCalledWith(1, "cancelled-token");
      expect(persist).toHaveBeenNthCalledWith(2, "owner-token");
      expect(readStoredStewardToken()).toBe("owner-token");
      expect(beforePublish).not.toHaveBeenCalled();
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
