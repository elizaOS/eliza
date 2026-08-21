/**
 * Exercises Google Chat list, send, and upload request deadlines through the
 * service's injectable HTTP boundary.
 */
import { describe, expect, it, vi } from "vitest";
import { GoogleChatService } from "./service.js";
import { GoogleChatApiError } from "./types.js";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected chat abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

function serviceWithFetch(fetchImpl: typeof fetch, timeoutMs = 1_000): GoogleChatService {
  const service = Object.create(GoogleChatService.prototype) as GoogleChatService;
  const accountId = "workspace";
  const states = new Map([
    [
      accountId,
      {
        accountId,
        settings: {
          accountId,
          audienceType: "app-url",
          audience: "https://example.com/googlechat",
          webhookPath: "/googlechat",
          spaces: [],
          requireMention: true,
          enabled: true,
        },
        auth: {},
        connected: true,
        cachedSpaces: [],
      },
    ],
  ]);
  Object.assign(service, {
    states,
    defaultAccountId: accountId,
    fetchImpl,
    chatTimeoutMs: timeoutMs,
    runtime: undefined,
  });
  vi.spyOn(service, "getAccessToken").mockResolvedValue("test-token");
  return service;
}

describe("Google Chat request deadlines", () => {
  it("aborts a stalled list-spaces request at the injected deadline", async () => {
    await expect(serviceWithFetch(stallUntilAborted(), 10).getSpaces()).rejects.toMatchObject({
      name: "TimeoutError",
    });
  });

  it("aborts a stalled send at the injected deadline", async () => {
    await expect(
      serviceWithFetch(stallUntilAborted(), 10).sendMessage({
        space: "spaces/bounded",
        text: "a bounded line",
      })
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("aborts a stalled upload at the injected deadline", async () => {
    await expect(
      serviceWithFetch(stallUntilAborted(), 10).uploadAttachment(
        "spaces/bounded",
        "note.txt",
        Buffer.from("hi"),
        "text/plain"
      )
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed send", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("quota exceeded", { status: 429, statusText: "Too Many Requests" });

    await expect(
      serviceWithFetch(fetchImpl).sendMessage({
        space: "spaces/bounded",
        text: "a bounded line",
      })
    ).rejects.toBeInstanceOf(GoogleChatApiError);
    await expect(
      serviceWithFetch(fetchImpl).sendMessage({
        space: "spaces/bounded",
        text: "a bounded line",
      })
    ).rejects.toThrow("quota exceeded");
  });

  it("uses the injected fetch for a successful list-spaces call", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        spaces: [{ name: "spaces/bounded", displayName: "Bounded" }],
      });
    };

    const spaces = await serviceWithFetch(fetchImpl).getSpaces();

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(spaces[0]?.name).toBe("spaces/bounded");
  });
});
