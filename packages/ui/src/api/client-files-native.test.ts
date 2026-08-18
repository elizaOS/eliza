/**
 * Native-complete bar: real ElizaClient + request transport context.
 * Proves file list/delete hops carry timeoutMs into Agent.request.
 */
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

describe("ElizaClient files native transport", () => {
  beforeEach(() => {
    setBootConfig({ branding: {} });
  });

  it("forwards the list deadline to Agent.request", async () => {
    const request = vi.fn<AgentRequestTransport["request"]>(async () =>
      Response.json({ files: [] }),
    );
    await makeClient(request).listFiles();
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/files",
      expect.any(Object),
      { timeoutMs: FILES_LIST_FETCH_TIMEOUT_MS },
    );
  });

  it("forwards the delete deadline to Agent.request", async () => {
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

  it("times out a stalled list hop through ElizaClient", async () => {
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
    await expect(makeClient(request).listFiles(10)).rejects.toMatchObject({
      name: "ApiError",
      kind: "timeout",
    });
    expect(request).toHaveBeenCalledWith(
      "http://agent.example:2138/api/files",
      expect.any(Object),
      { timeoutMs: 10 },
    );
  });
});
