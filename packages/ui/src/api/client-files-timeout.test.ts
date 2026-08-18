/** Verifies file list/delete hops pass timeoutMs through ElizaClient.fetch. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElizaClient } from "./client-base";
import {
  FILES_DELETE_FETCH_TIMEOUT_MS,
  FILES_LIST_FETCH_TIMEOUT_MS,
} from "./client-files";
import "./client-files";
import type { AgentRequestTransport } from "./transport";
import { setBootConfig } from "../config/boot-config";

function makeClient(request: AgentRequestTransport["request"]) {
  const client = new ElizaClient("http://agent.example:2138", "token");
  client.setRequestTransport({ request });
  return client;
}

describe("ElizaClient files native-complete deadlines", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("keeps a documented budget per hop", () => {
    expect(FILES_LIST_FETCH_TIMEOUT_MS).toBe(10_000);
    expect(FILES_DELETE_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("passes list timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ files: [], restricted: false }),
    );
    await makeClient(request).listFiles();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/files",
      expect.any(Object),
      { timeoutMs: FILES_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("passes delete timeoutMs through client.fetch", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ deleted: true }),
    );
    await makeClient(request).deleteFile("note.pdf");
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/files/note.pdf",
      expect.any(Object),
      { timeoutMs: FILES_DELETE_FETCH_TIMEOUT_MS },
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
      makeClient(request).deleteFile("note.pdf", 10),
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
    await expect(makeClient(request).listFiles()).rejects.toMatchObject({
      name: "ApiError",
      status: 503,
    });
  });
});
