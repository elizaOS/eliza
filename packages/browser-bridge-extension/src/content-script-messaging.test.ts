/**
 * Deterministic tests for one-shot content-script transport recovery and
 * duplicate-listener prevention on healthy pages.
 */
import { describe, expect, it, vi } from "vitest";
import {
  assertContentScriptPageUrl,
  sendWithContentScriptRecovery,
} from "./content-script-messaging";

describe("assertContentScriptPageUrl", () => {
  it("binds page access to the exact URL authorized by the service worker", () => {
    expect(() =>
      assertContentScriptPageUrl(
        "https://allowed.example/form",
        "https://allowed.example/form",
      ),
    ).not.toThrow();
    expect(() =>
      assertContentScriptPageUrl(
        "https://allowed.example/form",
        "https://other.example/redirect",
      ),
    ).toThrow("page navigated after browser action authorization");
  });
});

describe("sendWithContentScriptRecovery", () => {
  it("does not reinject when the existing listener responds", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true });
    const inject = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendWithContentScriptRecovery({ send, inject }),
    ).resolves.toEqual({ ok: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(inject).not.toHaveBeenCalled();
  });

  it("injects once after a missing receiver and retries the original message", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error("Receiving end does not exist"))
      .mockResolvedValueOnce({ ok: true });
    const inject = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendWithContentScriptRecovery({ send, inject }),
    ).resolves.toEqual({ ok: true });
    expect(inject).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("surfaces the retry failure without an injection loop", async () => {
    const send = vi.fn().mockRejectedValue(new Error("blocked page"));
    const inject = vi.fn().mockResolvedValue(undefined);

    await expect(
      sendWithContentScriptRecovery({ send, inject }),
    ).rejects.toThrow("blocked page");
    expect(inject).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
  });
});
