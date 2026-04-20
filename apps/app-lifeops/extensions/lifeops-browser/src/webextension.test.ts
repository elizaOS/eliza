import { afterEach, describe, expect, it } from "vitest";
import { sendRuntimeMessage } from "./webextension";

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
});
