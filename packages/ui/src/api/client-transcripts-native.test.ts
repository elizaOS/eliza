/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves transcript hops carry timeoutMs into Agent.request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  TRANSCRIPTS_GET_FETCH_TIMEOUT_MS,
  TRANSCRIPTS_LIST_FETCH_TIMEOUT_MS,
  TRANSCRIPTS_SHARE_FETCH_TIMEOUT_MS,
} from "./client-transcripts";
import "./client-transcripts";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient transcript native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the list deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ transcripts: [] }),
    );
    await makeClient(request).listTranscripts();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts",
      expect.any(Object),
      { timeoutMs: TRANSCRIPTS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the get deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ transcript: { id: "t1" } }),
    );
    await makeClient(request).getTranscript("t1");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts/t1",
      expect.any(Object),
      { timeoutMs: TRANSCRIPTS_GET_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the share deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({
        ok: true,
        transcriptId: "t1",
        entityId: "e1",
        mode: "full",
      }),
    );
    await makeClient(request).shareTranscript("t1", {
      entityId: "e1",
      mode: "full",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts/t1/share",
      expect.any(Object),
      { timeoutMs: TRANSCRIPTS_SHARE_FETCH_TIMEOUT_MS },
    );
  });

  it("times out a stalled get hop through ElizaClient", async () => {
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
      makeClient(request).getTranscript("t1", 10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts/t1",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
