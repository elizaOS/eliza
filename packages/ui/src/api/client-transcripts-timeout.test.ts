/** Verifies transcript hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  TRANSCRIPTS_CREATE_FETCH_TIMEOUT_MS,
  TRANSCRIPTS_DELETE_FETCH_TIMEOUT_MS,
  TRANSCRIPTS_GET_FETCH_TIMEOUT_MS,
  TRANSCRIPTS_LIST_FETCH_TIMEOUT_MS,
  TRANSCRIPTS_PRIVACY_FETCH_TIMEOUT_MS,
  TRANSCRIPTS_REVOKE_SHARE_FETCH_TIMEOUT_MS,
  TRANSCRIPTS_SHARE_FETCH_TIMEOUT_MS,
  TRANSCRIPTS_SOURCE_AUDIO_FETCH_TIMEOUT_MS,
  TRANSCRIPTS_UPDATE_FETCH_TIMEOUT_MS,
} from "./client-transcripts";
import "./client-transcripts";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient transcript native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(TRANSCRIPTS_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(TRANSCRIPTS_GET_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(TRANSCRIPTS_CREATE_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(TRANSCRIPTS_UPDATE_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(TRANSCRIPTS_DELETE_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(TRANSCRIPTS_SHARE_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(TRANSCRIPTS_REVOKE_SHARE_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(TRANSCRIPTS_PRIVACY_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(TRANSCRIPTS_SOURCE_AUDIO_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes list timeoutMs through client.fetch", async () => {
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

  it("passes list-by-room timeoutMs on its own hop", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ transcripts: [] }),
    );
    await makeClient(request).listTranscripts("room-1");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts?roomId=room-1",
      expect.any(Object),
      { timeoutMs: TRANSCRIPTS_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("passes get timeoutMs through client.fetch", async () => {
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

  it("passes create timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ transcript: { id: "t1" } }),
    );
    await makeClient(request).createTranscript({ segments: [] });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts",
      expect.any(Object),
      { timeoutMs: TRANSCRIPTS_CREATE_FETCH_TIMEOUT_MS },
    );
  });

  it("passes update timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ transcript: { id: "t1" } }),
    );
    await makeClient(request).updateTranscript("t1", { title: "Edited" });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts/t1",
      expect.any(Object),
      { timeoutMs: TRANSCRIPTS_UPDATE_FETCH_TIMEOUT_MS },
    );
  });

  it("passes delete timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true }),
    );
    await makeClient(request).deleteTranscript("t1");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts/t1",
      expect.any(Object),
      { timeoutMs: TRANSCRIPTS_DELETE_FETCH_TIMEOUT_MS },
    );
  });

  it("passes share timeoutMs through client.fetch", async () => {
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

  it("passes revoke-share timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ ok: true, transcriptId: "t1", entityId: "e1" }),
    );
    await makeClient(request).revokeTranscriptShare("t1", "e1");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts/t1/share/e1",
      expect.any(Object),
      { timeoutMs: TRANSCRIPTS_REVOKE_SHARE_FETCH_TIMEOUT_MS },
    );
  });

  it("passes privacy timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ transcript: { id: "t1" } }),
    );
    await makeClient(request).updateTranscriptPrivacy("t1", {
      sharing: {},
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts/t1/privacy",
      expect.any(Object),
      { timeoutMs: TRANSCRIPTS_PRIVACY_FETCH_TIMEOUT_MS },
    );
  });

  it("passes source-audio timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ deleted: true, transcript: { id: "t1" } }),
    );
    await makeClient(request).deleteTranscriptSourceAudio("t1");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/transcripts/t1/source-audio",
      expect.any(Object),
      { timeoutMs: TRANSCRIPTS_SOURCE_AUDIO_FETCH_TIMEOUT_MS },
    );
  });

  it("aborts a stalled delete hop as TimeoutError", async () => {
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
      makeClient(request).deleteTranscript("t1", 10),
    ).rejects.toMatchObject({ name: "ApiError", kind: "timeout" });
  });

  it("surfaces a provider error from a completed list GET", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(makeClient(request).listTranscripts()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
