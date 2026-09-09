/** Exercises real cookie recovery, HTTP refresh and guarded persistence with synthetic browser/device boundaries. */
// @vitest-environment jsdom

import {
  hasStewardAuthedCookie,
  registerStewardTokenPersistence,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureCloudSessionForRepair } from "./cloud-session-refresh-for-repair";

function cookie(value: string): void {
  // biome-ignore lint/suspicious/noDocumentCookie: synthetic browser marker, not an actual login cookie.
  document.cookie = value;
}

describe("cookie recovery original ownership", () => {
  beforeEach(() => {
    localStorage.clear();
    cookie("steward-authed=1; Path=/");
    expect(hasStewardAuthedCookie()).toBe(true);
  });
  afterEach(() => {
    cookie("steward-authed=; Max-Age=0; Path=/");
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("aborts the request on its deadline while keeping the honest empty-session result", async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init: RequestInit) => {
        signal = init.signal ?? undefined;
        await held;
        return Response.json({ token: "late-cookie-token" });
      }),
    );
    try {
      expect(await ensureCloudSessionForRepair({ timeoutMs: 30 })).toBeNull();
      expect(signal?.aborted).toBe(true);
    } finally {
      release();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
  });

  it.each(["abort", "target"])(
    "does not publish after %s while persistence is pending",
    async (change) => {
      let release!: () => void;
      let enter!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const publish = vi.fn();
      const unregister = registerStewardTokenPersistence(
        async (token, validate, scope) => {
          enter();
          await held;
          validate();
          scope.commit(() => {
            publish();
            localStorage.setItem(STEWARD_TOKEN_KEY, token);
          });
        },
      );
      const controller = new AbortController();
      let current = true;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ token: "recovered-token" })),
      );
      const result = ensureCloudSessionForRepair({
        signal: controller.signal,
        beforePublish: () => {
          if (!current) throw new Error("Recovery target changed");
        },
      }).catch(() => null);
      try {
        await entered;
        if (change === "abort") controller.abort();
        else current = false;
        release();
        expect(await result).toBeNull();
        expect(publish).not.toHaveBeenCalled();
        expect(localStorage.getItem(STEWARD_TOKEN_KEY)).toBeNull();
      } finally {
        release();
        await result;
        unregister();
      }
    },
  );
});
