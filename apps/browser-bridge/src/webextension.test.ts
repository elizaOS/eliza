import { afterEach, describe, expect, it } from "vitest";
import {
  sendRuntimeMessage,
  storageGet,
  storageRemove,
  storageSet,
} from "./webextension";

describe("webextension API selection", () => {
  afterEach(() => {
    delete (
      globalThis as typeof globalThis & {
        browser?: Record<string, unknown>;
        chrome?: Record<string, unknown>;
      }
    ).browser;
    delete (
      globalThis as typeof globalThis & {
        browser?: Record<string, unknown>;
        chrome?: Record<string, unknown>;
      }
    ).chrome;
  });

  it("prefers chrome over a partial browser shim when runtime messaging is needed", async () => {
    (
      globalThis as typeof globalThis & {
        browser?: Record<string, unknown>;
        chrome?: Record<string, unknown>;
      }
    ).browser = {
      runtime: {},
    };
    (
      globalThis as typeof globalThis & {
        browser?: Record<string, unknown>;
        chrome?: Record<string, unknown>;
      }
    ).chrome = {
      runtime: {
        lastError: undefined,
        sendMessage: (
          _message: unknown,
          callback?: (value: unknown) => void,
        ) => {
          callback?.({ ok: true });
          return undefined;
        },
      },
    };

    await expect(sendRuntimeMessage({ type: "ping" })).resolves.toEqual({
      ok: true,
    });
  });

  it("falls back to browser when chrome is unavailable", async () => {
    (
      globalThis as typeof globalThis & {
        browser?: Record<string, unknown>;
      }
    ).browser = {
      runtime: {
        lastError: undefined,
        sendMessage: (
          _message: unknown,
          callback?: (value: unknown) => void,
        ) => {
          callback?.({ ok: "browser" });
          return undefined;
        },
      },
    };

    await expect(sendRuntimeMessage({ type: "ping" })).resolves.toEqual({
      ok: "browser",
    });
  });

  it("rejects storage operations when storage.local is unavailable", async () => {
    (
      globalThis as typeof globalThis & {
        chrome?: Record<string, unknown>;
      }
    ).chrome = {
      runtime: {},
      storage: {},
    };

    await expect(storageGet("key")).rejects.toThrow(
      /storage\.local\.get is unavailable/,
    );
    await expect(storageSet({ key: "value" })).rejects.toThrow(
      /storage\.local\.set is unavailable/,
    );
    await expect(storageRemove("key")).rejects.toThrow(
      /storage\.local\.remove is unavailable/,
    );
  });
});
