/**
 * Exercises direct provider credential probes against deterministic fetch
 * responses, including complete provider diagnostics and unavailable bodies.
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeDirectApiKey } from "./direct-api-probe.ts";

describe("probeDirectApiKey", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it.each([200, 503])(
    "releases unread HTTP %i bodies after the probe",
    async (status) => {
      let closed = false;
      const server = createServer((_request, response) => {
        response.on("close", () => {
          closed = true;
        });
        response.writeHead(status, { "Content-Length": String(128 * 1024) });
        response.flushHeaders();
        response.write("{");
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Expected TCP listener");
      vi.stubEnv("OPENAI_BASE_URL", `http://127.0.0.1:${address.port}`);
      try {
        const result = await probeDirectApiKey("openai-api", "fixture-key");
        expect(result.status).toBe(status);
        expect(result.ok).toBe(status === 200);
        await vi.waitFor(() => expect(closed).toBe(true));
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("preserves a provider failure body without truncation", async () => {
    const body = JSON.stringify({
      error: {
        message: "x".repeat(256),
        requestId: "request-that-must-remain-visible",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 401,
        }),
      ),
    );

    await expect(
      probeDirectApiKey("openai-api", "revoked-key"),
    ).resolves.toMatchObject({
      ok: false,
      status: 401,
      error: `openai-api 401: ${body}`,
    });
  });

  it("rejects an over-limit body without retaining a misleading prefix", async () => {
    // Operator-provided base URLs can return arbitrary bodies; rejection must
    // remain distinct from a complete provider diagnostic.
    const oversized = "y".repeat(64 * 1024 + 10);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(oversized, { status: 500 })),
    );

    const result = await probeDirectApiKey("openai-api", "provider-key");

    expect(result.error).toBe(
      `openai-api 500: [response body rejected: more than ${64 * 1024} bytes exceeds the probe diagnostic limit]`,
    );
    expect(result.error).not.toContain("y".repeat(100));
  });

  it("keeps the HTTP status when the provider body cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("stream failed"));
            },
          }),
          { status: 503 },
        ),
      ),
    );

    await expect(
      probeDirectApiKey("deepseek-api", "provider-key"),
    ).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: "deepseek-api 503: [response body unavailable: stream failed]",
    });
  });

  it("does not read a successful response body", async () => {
    const text = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, text }),
    );

    await expect(
      probeDirectApiKey("cerebras-api", "provider-key"),
    ).resolves.toMatchObject({ ok: true, status: 200 });
    expect(text).not.toHaveBeenCalled();
  });
});
