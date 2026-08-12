/**
 * Verifies the public MCP Registry client against mocked wire responses:
 * bounded reads, cancellation, stable errors, proportional schema validation,
 * search mapping, and the official latest-version detail endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMcpServerDetails,
  McpMarketplaceError,
  searchMcpMarketplace,
} from "../src/mcp-marketplace.js";

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
}

function registryList(...servers: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    servers: servers.map((server) => ({
      server,
      _meta: {
        "io.modelcontextprotocol.registry/official": {
          isLatest: true,
          publishedAt: "2026-08-12T00:00:00.000Z",
        },
      },
    })),
  };
}

describe("MCP marketplace client", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("maps a mixed page and tolerates unrelated registry argument shapes", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        registryList(
          {
            name: "io.example/local",
            title: "Local tools",
            description: "Local MCP server",
            version: "1.0.0",
            packages: [
              {
                registryType: "npm",
                identifier: "@example/local",
                transport: { type: "stdio" },
              },
            ],
          },
          {
            name: "io.example/remote",
            title: "Remote tools",
            description: "",
            version: "2.1.0",
            repository: { url: "https://github.com/example/remote" },
            packages: [
              {
                registryType: "npm",
                identifier: "@example/remote",
                version: "2.1.0",
                transport: {
                  type: "streamable-http",
                  url: "https://mcp.example.test/api",
                },
                packageArguments: [
                  { type: "positional", valueHint: "workspace" },
                  { type: "named", name: "--verbose" },
                ],
              },
            ],
            icons: [{ src: "https://mcp.example.test/icon.png" }],
          }
        )
      )
    );
    const caller = new AbortController();

    const result = await searchMcpMarketplace(undefined, 10, {
      signal: caller.signal,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.modelcontextprotocol.io/v0/servers",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    const forwardedSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(forwardedSignal).not.toBe(caller.signal);
    expect(result.results).toEqual([
      expect.objectContaining({
        id: "io.example/local@1.0.0",
        connectionType: "stdio",
        npmPackage: "@example/local",
      }),
      expect.objectContaining({
        id: "io.example/remote@2.1.0",
        connectionType: "remote",
        connectionUrl: "https://mcp.example.test/api",
        description: "No description",
        iconUrl: "https://mcp.example.test/icon.png",
        isLatest: true,
      }),
    ]);
  });

  it("fails closed on invalid JSON or a consumed field with the wrong type", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not json"));
    await expect(searchMcpMarketplace()).rejects.toMatchObject({
      code: "invalid_response",
    });

    fetchMock.mockResolvedValue(
      jsonResponse(
        registryList({
          name: "io.example/files",
          description: "Files",
          version: 7,
        })
      )
    );

    await expect(searchMcpMarketplace()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects declared and streamed responses over the configured byte cap", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { headers: { "content-length": "11" } }));
    await expect(
      searchMcpMarketplace(undefined, 30, { maxResponseBytes: 10 })
    ).rejects.toMatchObject({ code: "response_too_large" });

    const encoder = new TextEncoder();
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("123456"));
            controller.enqueue(encoder.encode("789012"));
            controller.close();
          },
        })
      )
    );
    await expect(
      searchMcpMarketplace(undefined, 30, { maxResponseBytes: 10 })
    ).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("distinguishes caller cancellation, timeout, network, and HTTP failures", async () => {
    fetchMock.mockImplementation(async (_input, init) => {
      await new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
      throw new Error("unreachable");
    });

    const caller = new AbortController();
    const aborted = searchMcpMarketplace(undefined, 30, {
      signal: caller.signal,
    });
    caller.abort(new Error("cancelled"));
    await expect(aborted).rejects.toMatchObject({ code: "aborted" });

    await expect(searchMcpMarketplace(undefined, 30, { timeoutMs: 1 })).rejects.toMatchObject({
      code: "timeout",
    });

    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await expect(searchMcpMarketplace()).rejects.toMatchObject({
      code: "network_error",
    });

    fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
    await expect(searchMcpMarketplace()).rejects.toMatchObject({
      code: "http_error",
      status: 503,
    });
  });

  it("rejects invalid request options before issuing a network request", async () => {
    await expect(searchMcpMarketplace(undefined, 30, { timeoutMs: 0 })).rejects.toEqual(
      expect.any(McpMarketplaceError)
    );
    await expect(
      searchMcpMarketplace(undefined, 30, { maxResponseBytes: Number.MAX_VALUE })
    ).rejects.toMatchObject({ code: "invalid_options" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the official latest-version detail endpoint and maps 404 to null", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        server: {
          name: "io.example/files",
          description: "Files",
          version: "1.0.0",
        },
      })
    );

    await expect(getMcpServerDetails("io.example/files")).resolves.toEqual(
      expect.objectContaining({ name: "io.example/files", version: "1.0.0" })
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://registry.modelcontextprotocol.io/v0/servers/io.example%2Ffiles/versions/latest",
      expect.any(Object)
    );

    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(getMcpServerDetails("missing")).resolves.toBeNull();
  });
});
