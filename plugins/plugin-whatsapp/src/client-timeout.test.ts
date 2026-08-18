/**
 * Behavioral WhatsApp Cloud API deadlines. Executes request() under abort —
 * not a source-grep of client.ts.
 */
import { describe, expect, it } from "vitest";
import {
  WHATSAPP_REQUEST_TIMEOUT_MS,
  whatsAppRequestWithFetch,
} from "./client.ts";

const REQUEST_URL = "https://graph.facebook.com/v24.0/123/messages";
const AUTH_HEADERS = {
  Authorization: "Bearer tok",
  "Content-Type": "application/json",
};

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected whatsapp abort signal");
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    })) as typeof fetch;
}

describe("WhatsApp Cloud API request deadlines", () => {
  it("keeps a documented Cloud API budget", () => {
    expect(WHATSAPP_REQUEST_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled request at the injected deadline", async () => {
    await expect(
      whatsAppRequestWithFetch(
        REQUEST_URL,
        AUTH_HEADERS,
        { method: "POST" },
        stallUntilAborted(),
        10
      )
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed request", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: "invalid token" } }), {
        status: 401,
        statusText: "Unauthorized",
      });

    await expect(
      whatsAppRequestWithFetch(REQUEST_URL, AUTH_HEADERS, { method: "POST" }, fetchImpl, 1_000)
    ).rejects.toThrow("WhatsApp Cloud API request failed (401 Unauthorized)");
  });

  it("uses the injected fetch for a successful request", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ messages: [{ id: "wamid.1" }] });
    };

    const result = await whatsAppRequestWithFetch<{ messages: Array<{ id: string }> }>(
      REQUEST_URL,
      AUTH_HEADERS,
      { method: "POST" },
      fetchImpl,
      1_000
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(result.status).toBe(200);
    expect(result.data.messages[0]?.id).toBe("wamid.1");
  });

  it("preserves a caller-supplied cancellation signal", async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      return Response.json({ messages: [{ id: "caller" }] });
    };

    await whatsAppRequestWithFetch(
      REQUEST_URL,
      AUTH_HEADERS,
      { method: "POST", signal: controller.signal },
      fetchImpl,
      10
    );
  });
});
