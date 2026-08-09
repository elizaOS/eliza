/**
 * Covers the MCP Registry marketplace client's bounded I/O, schema validation,
 * transport mapping, and stable error boundary with deterministic responses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getMcpServerDetails,
  McpMarketplaceError,
  searchMcpMarketplace,
} from "./mcp-marketplace.ts";

const server = {
  name: "io.example/files",
  title: "Example Files",
  description: "File tools",
  version: "1.2.3",
  websiteUrl: "https://example.test",
  repository: { url: "https://github.com/example/files", source: "github" },
  remotes: [{ type: "streamable-http", url: "https://example.test/mcp" }],
  icons: [{ src: "https://example.test/icon.png" }],
};

function listResponse(overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    servers: [
      {
        server,
        _meta: {
          "io.modelcontextprotocol.registry/official": {
            isLatest: true,
            publishedAt: "2026-08-09T00:00:00Z",
          },
        },
      },
    ],
    metadata: { count: 1 },
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchMcpMarketplace", () => {
  it("maps validated latest registry entries and forwards a composed abort signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(listResponse());
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(
      searchMcpMarketplace("files", 5, {
        signal: controller.signal,
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({
      results: [
        {
          id: "io.example/files@1.2.3",
          name: "io.example/files",
          title: "Example Files",
          description: "File tools",
          version: "1.2.3",
          connectionType: "remote",
          connectionUrl: "https://example.test/mcp",
          npmPackage: undefined,
          dockerImage: undefined,
          repositoryUrl: "https://github.com/example/files",
          websiteUrl: "https://example.test",
          iconUrl: "https://example.test/icon.png",
          publishedAt: "2026-08-09T00:00:00Z",
          isLatest: true,
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.modelcontextprotocol.io/v0/servers",
      expect.objectContaining({
        headers: { Accept: "application/json" },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("accepts mixed official argument and package transport unions", async () => {
    const packageServer = {
      name: "io.example/packaged",
      title: "Packaged Example",
      description: "A package with configurable arguments",
      version: "2.0.0",
      packages: [
        {
          registryType: "npm",
          identifier: "@example/packaged-mcp",
          version: "2.0.0",
          transport: {
            type: "streamable-http",
            url: "https://example.test/packaged/mcp",
          },
          packageArguments: [
            {
              type: "positional",
              valueHint: "workspace",
              isRequired: true,
            },
            {
              type: "named",
              name: "--token",
              isSecret: true,
            },
          ],
        },
        {
          registryType: "npm",
          identifier: "@example/packaged-sse",
          transport: {
            type: "sse",
            url: "https://example.test/packaged/sse",
          },
          runtimeArguments: [
            {
              type: "positional",
              value: "--verbose",
            },
          ],
        },
      ],
    };
    const officialMeta = {
      "io.modelcontextprotocol.registry/official": {
        isLatest: true,
        publishedAt: "2026-08-09T00:00:00Z",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      listResponse({
        servers: [
          { server: packageServer, _meta: officialMeta },
          { server, _meta: officialMeta },
        ],
        metadata: { count: 2 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchMcpMarketplace()).resolves.toMatchObject({
      results: [
        {
          name: "io.example/packaged",
          connectionType: "remote",
          connectionUrl: "https://example.test/packaged/mcp",
          npmPackage: undefined,
          dockerImage: undefined,
        },
        {
          name: "io.example/files",
          connectionType: "remote",
          connectionUrl: "https://example.test/mcp",
        },
      ],
    });
  });

  it("rejects malformed registry payloads with a stable typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ servers: {} })),
    );

    const error = await searchMcpMarketplace().catch((caught) => caught);

    expect(error).toBeInstanceOf(McpMarketplaceError);
    expect(error).toMatchObject({ code: "invalid_response" });
  });

  it("rejects a declared response that exceeds the configured byte limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ servers: [] }), {
          headers: { "content-length": "1024" },
        }),
      ),
    );

    const error = await searchMcpMarketplace(undefined, 30, {
      maxResponseBytes: 64,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: "response_too_large" });
  });

  it("stops reading a chunked response that exceeds the configured byte limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("x".repeat(65)));
              controller.close();
            },
          }),
        ),
      ),
    );

    const error = await searchMcpMarketplace(undefined, 30, {
      maxResponseBytes: 64,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: "response_too_large" });
  });

  it("reports caller cancellation distinctly from transport failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        });
      }),
    );
    const controller = new AbortController();
    const request = searchMcpMarketplace(undefined, 30, {
      signal: controller.signal,
    });

    controller.abort();

    const error = await request.catch((caught) => caught);
    expect(error).toMatchObject({ code: "aborted" });
  });

  it("reports request deadlines as typed timeout errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            {
              once: true,
            },
          );
        });
      }),
    );

    const error = await searchMcpMarketplace(undefined, 30, {
      timeoutMs: 1,
    }).catch((caught) => caught);

    expect(error).toMatchObject({ code: "timeout" });
  });

  it("reports network and HTTP failures with stable error codes", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new Error("offline")));
    await expect(searchMcpMarketplace()).rejects.toMatchObject({
      code: "network_error",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })),
    );
    await expect(searchMcpMarketplace()).rejects.toMatchObject({
      code: "http_error",
      status: 503,
    });
  });

  it("rejects unsafe resource limit options before issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      searchMcpMarketplace(undefined, 30, { maxResponseBytes: 0 }),
    ).rejects.toMatchObject({ code: "invalid_options" });
    await expect(
      searchMcpMarketplace(undefined, 30, { timeoutMs: 120_001 }),
    ).rejects.toMatchObject({ code: "invalid_options" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("getMcpServerDetails", () => {
  it("uses the official latest-version endpoint and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ server }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      getMcpServerDetails("io.example/files"),
    ).resolves.toMatchObject({
      name: "io.example/files",
      version: "1.2.3",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://registry.modelcontextprotocol.io/v0/servers/io.example%2Ffiles/versions/latest",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("preserves the null result for a missing server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(null, { status: 404 })),
    );

    await expect(getMcpServerDetails("io.example/missing")).resolves.toBeNull();
  });

  it("rejects details responses without a valid server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json({ server: null })),
    );

    await expect(getMcpServerDetails("io.example/files")).rejects.toMatchObject(
      {
        code: "invalid_response",
      },
    );
  });
});
