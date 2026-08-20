/**
 * Verifies the public MCP Registry client against mocked wire responses:
 * bounded reads, cancellation, stable errors, proportional schema validation,
 * search mapping, and the official latest-version detail endpoint.
 */
import { getEventListeners } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getMcpServerDetails,
  MAX_MCP_MARKETPLACE_PAGES,
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

function registryPage(
  servers: Array<Record<string, unknown>>,
  nextCursor?: string
): Record<string, unknown> {
  return {
    ...registryList(...servers),
    ...(nextCursor ? { metadata: { nextCursor } } : {}),
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
      "https://registry.modelcontextprotocol.io/v0/servers?version=latest&limit=10",
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

  it("detaches the caller abort listener once a request settles on its own", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        registryList({
          name: "io.example/files",
          description: "Files",
          version: "1.0.0",
        })
      )
    );
    const caller = new AbortController();
    const addListener = vi.spyOn(caller.signal, "addEventListener");
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");

    await searchMcpMarketplace(undefined, 10, { signal: caller.signal });

    const abortListener = addListener.mock.calls.find(([type]) => type === "abort")?.[1];
    expect(abortListener).toBeTypeOf("function");
    expect(removeListener).toHaveBeenCalledWith("abort", abortListener);
  });

  it("keeps a shared caller signal flat across repeated settled searches", async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse(
        registryList({
          name: "io.example/files",
          description: "Files",
          version: "1.0.0",
        })
      )
    );
    const caller = new AbortController();

    for (let index = 0; index < 12; index += 1) {
      await searchMcpMarketplace(undefined, 10, { signal: caller.signal });
      expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
    }
  });

  it("detaches the caller abort listener on detail success and handled 404", async () => {
    const caller = new AbortController();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        server: {
          name: "io.example/files",
          description: "Files",
          version: "1.0.0",
        },
      })
    );

    await expect(
      getMcpServerDetails("io.example/files", { signal: caller.signal })
    ).resolves.toMatchObject({ name: "io.example/files" });
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);

    fetchMock.mockResolvedValueOnce(new Response("missing", { status: 404 }));
    await expect(
      getMcpServerDetails("io.example/missing", { signal: caller.signal })
    ).resolves.toBeNull();
    expect(getEventListeners(caller.signal, "abort")).toHaveLength(0);
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

  it("fails closed on missing or unsupported consumed transport fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        registryList({
          name: "io.example/remote",
          description: "Remote",
          version: "1.0.0",
          remotes: [{ url: "https://mcp.example.test" }],
        })
      )
    );
    await expect(searchMcpMarketplace()).rejects.toMatchObject({ code: "invalid_response" });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        registryList({
          name: "io.example/package",
          description: "Package",
          version: "1.0.0",
          packages: [{ registryType: "npm", identifier: "pkg", transport: { type: "bogus" } }],
        })
      )
    );
    await expect(searchMcpMarketplace()).rejects.toMatchObject({ code: "invalid_response" });

    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        registryList({
          name: "io.example/missing-transport",
          description: "Package",
          version: "1.0.0",
          packages: [{ registryType: "npm", identifier: "pkg" }],
        })
      )
    );
    await expect(searchMcpMarketplace()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("paginates the latest Registry catalog and preserves the overall byte budget", async () => {
    const firstPage = registryPage(
      [
        {
          name: "io.example/other",
          description: "Other",
          version: "1.0.0",
        },
      ],
      "next-page"
    );
    fetchMock.mockResolvedValueOnce(jsonResponse(firstPage)).mockResolvedValueOnce(
      jsonResponse(
        registryPage([
          {
            name: "io.example/needle",
            description: "Needle",
            version: "1.0.0",
          },
        ]),
        { headers: { "content-length": "2" } }
      )
    );

    await expect(
      searchMcpMarketplace("needle", 1, {
        maxResponseBytes: JSON.stringify(firstPage).length + 1,
      })
    ).rejects.toMatchObject({ code: "response_too_large" });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://registry.modelcontextprotocol.io/v0/servers?version=latest&limit=50",
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://registry.modelcontextprotocol.io/v0/servers?version=latest&limit=50&cursor=next-page",
      expect.any(Object)
    );
  });

  it("returns a later-page title match without narrowing the Registry request to names", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          registryPage(
            [{ name: "io.example/other", description: "Other", version: "1.0.0" }],
            "next-page"
          )
        )
      )
      .mockResolvedValueOnce(
        jsonResponse(
          registryPage([
            {
              name: "io.example/portfolio",
              title: "Aether Wealth",
              description: "Macro calendar and indicators",
              version: "1.0.0",
            },
          ])
        )
      );

    await expect(searchMcpMarketplace("wealth", 1)).resolves.toEqual({
      results: [expect.objectContaining({ name: "io.example/portfolio", title: "Aether Wealth" })],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://registry.modelcontextprotocol.io/v0/servers?version=latest&limit=50",
      expect.any(Object)
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://registry.modelcontextprotocol.io/v0/servers?version=latest&limit=50&cursor=next-page",
      expect.any(Object)
    );
  });

  it("allows a match on the final page in the request budget", async () => {
    let callIndex = 0;
    fetchMock.mockImplementation(async () => {
      callIndex += 1;
      if (callIndex === MAX_MCP_MARKETPLACE_PAGES) {
        return jsonResponse(
          registryPage([
            {
              name: "io.example/final-page",
              title: "Last Page Match",
              description: "Found at the bounded edge",
              version: "1.0.0",
            },
          ])
        );
      }
      return jsonResponse(registryPage([], `page-cursor-${callIndex}`));
    });

    await expect(searchMcpMarketplace("last page", 1)).resolves.toEqual({
      results: [expect.objectContaining({ name: "io.example/final-page" })],
    });
    expect(fetchMock).toHaveBeenCalledTimes(MAX_MCP_MARKETPLACE_PAGES);
  });

  it("rejects a pagination cursor cycle before refetching it", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(registryPage([], "repeated-cursor")));

    await expect(searchMcpMarketplace("unmatched-query", 10)).rejects.toMatchObject({
      code: "invalid_response",
      message: expect.stringContaining("repeated a pagination cursor"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects MCP registry pagination exceeding the maximum page limit", async () => {
    let callIndex = 0;
    fetchMock.mockImplementation(async () => {
      callIndex += 1;
      return jsonResponse(registryPage([], `runaway-cursor-${callIndex}`));
    });

    await expect(searchMcpMarketplace("unmatched-query", 10)).rejects.toMatchObject({
      code: "invalid_response",
      message: expect.stringContaining(
        `pagination exceeded ${MAX_MCP_MARKETPLACE_PAGES} page limit`
      ),
    });

    expect(fetchMock).toHaveBeenCalledTimes(MAX_MCP_MARKETPLACE_PAGES);
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

  it("preserves the first abort cause when timeout and caller cancellation race", async () => {
    let rejectFetch: (reason: unknown) => void = () => {};
    let requestSignal: AbortSignal | undefined;
    let observeAbort: () => void = () => {};
    let abortObserved = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    fetchMock.mockImplementationOnce(
      async (_input, init) =>
        await new Promise<never>((_resolve, reject) => {
          requestSignal = init?.signal;
          rejectFetch = reject;
          requestSignal?.addEventListener("abort", observeAbort, { once: true });
        })
    );

    const caller = new AbortController();
    const timedOut = searchMcpMarketplace(undefined, 1, { signal: caller.signal, timeoutMs: 10 });
    await abortObserved;
    caller.abort(new Error("late caller abort"));
    rejectFetch(requestSignal?.reason);
    await expect(timedOut).rejects.toMatchObject({ code: "timeout" });

    abortObserved = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    fetchMock.mockImplementationOnce(
      async (_input, init) =>
        await new Promise<never>((_resolve, reject) => {
          requestSignal = init?.signal;
          rejectFetch = reject;
          requestSignal?.addEventListener("abort", observeAbort, { once: true });
        })
    );
    const callerFirst = new AbortController();
    const callerFirstRequest = searchMcpMarketplace(undefined, 1, {
      signal: callerFirst.signal,
      timeoutMs: 10,
    });
    callerFirst.abort(new Error("caller abort"));
    await new Promise((resolve) => setTimeout(resolve, 15));
    rejectFetch(requestSignal?.reason);
    await expect(callerFirstRequest).rejects.toMatchObject({ code: "aborted" });
  });

  it("rejects invalid request options before issuing a network request", async () => {
    await expect(searchMcpMarketplace(undefined, 30, { timeoutMs: 0 })).rejects.toEqual(
      expect.any(McpMarketplaceError)
    );
    await expect(
      searchMcpMarketplace(undefined, 30, { maxResponseBytes: Number.MAX_VALUE })
    ).rejects.toMatchObject({ code: "invalid_options" });
    await expect(searchMcpMarketplace(undefined, 0)).rejects.toMatchObject({
      code: "invalid_options",
    });
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
