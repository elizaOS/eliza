/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves uploadBackgroundImage carries timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import { BACKGROUND_UPLOAD_FETCH_TIMEOUT_MS } from "./client-background";
import "./client-background";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

const dataUrl = "data:image/png;base64,xx";

describe("ElizaClient background native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget for the upload hop", () => {
    expect(BACKGROUND_UPLOAD_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("forwards the upload deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ url: "/api/media/hash" }),
    );
    await makeClient(request).uploadBackgroundImage(dataUrl);
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/background/upload-image",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: BACKGROUND_UPLOAD_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled upload hop through ElizaClient", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async (_url, init, ctx) => {
        const ms = ctx?.timeoutMs ?? 10;
        await new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(
              Object.assign(new Error(`Request timed out after ${ms}ms`), {
                name: "TimeoutError",
              }),
            );
          }, ms);
          init.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(
                Object.assign(new Error("The operation was aborted"), {
                  name: "AbortError",
                }),
              );
            },
            { once: true },
          );
        });
      },
    );
    await expect(
      makeClient(request).uploadBackgroundImage(dataUrl, 10),
    ).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/background/upload-image",
      expect.objectContaining({ method: "POST" }),
      { timeoutMs: 10 },
    );
  });

  it("surfaces a provider error from a completed upload POST", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(
      makeClient(request).uploadBackgroundImage(dataUrl),
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
