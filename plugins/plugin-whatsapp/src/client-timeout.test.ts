/**
 * Exercises WhatsApp Cloud API deadlines through the public client with
 * deterministic fetch and abort signals; no live Meta requests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppClient } from "./client.js";

function client(): WhatsAppClient {
  return new WhatsAppClient({
    accessToken: "tok",
    phoneNumberId: "123",
  });
}

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected WhatsApp abort signal");
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
    })) as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("WhatsApp Cloud API request deadlines", () => {
  it("aborts a stalled request at the Cloud API deadline", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    vi.stubGlobal("fetch", stallUntilAborted());

    const pending = client().sendTextMessage("+14155550100", "hi");
    controller.abort(new DOMException("deadline", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    expect(timeout).toHaveBeenCalledWith(15_000);
  });

  it("keeps response-body parsing inside the request deadline", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let bodyStarted = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        const signal = init?.signal;
        if (!signal) throw new Error("expected WhatsApp abort signal");
        return new Response(
          new ReadableStream({
            start(stream) {
              bodyStarted = true;
              signal.addEventListener("abort", () => stream.error(signal.reason), {
                once: true,
              });
            },
          })
        );
      })
    );

    const pending = client().sendTextMessage("+14155550100", "hi");
    await vi.waitFor(() => expect(bodyStarted).toBe(true));
    controller.abort(new DOMException("deadline", "TimeoutError"));

    await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("preserves provider errors and successful message payloads", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "invalid token" } }), {
          status: 401,
          statusText: "Unauthorized",
        })
      )
      .mockResolvedValueOnce(Response.json({ messages: [{ id: "wamid.1" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().sendTextMessage("+14155550100", "hi")).rejects.toThrow(
      "WhatsApp Cloud API request failed (401 Unauthorized)"
    );
    await expect(client().sendTextMessage("+14155550100", "hi")).resolves.toMatchObject({
      status: 200,
      data: { messages: [{ id: "wamid.1" }] },
    });
  });
});
