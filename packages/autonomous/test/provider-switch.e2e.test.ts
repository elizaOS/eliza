/**
 * E2E tests for POST /api/provider/switch
 *
 * Tests the provider switching endpoint using the real server.
 * No mocks — exercises actual production code paths.
 */

import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

// ---------------------------------------------------------------------------
// HTTP helper (same pattern as api-server.e2e.test.ts)
// ---------------------------------------------------------------------------

function req(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  data: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, data });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/provider/switch", () => {
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
  });

  // -- Validation --

  describe("input validation", () => {
    it("rejects missing body (no JSON)", async () => {
      const { status } = await req(port, "POST", "/api/provider/switch");
      // readJsonBody will return an error for missing/invalid body
      expect(status).toBeGreaterThanOrEqual(400);
    });

    it("rejects missing provider field", async () => {
      const { status, data } = await req(port, "POST", "/api/provider/switch", {
        apiKey: "sk-test-123",
      });
      expect(status).toBe(400);
      expect(data.error).toMatch(/missing provider/i);
    });

    it("rejects empty string provider", async () => {
      const { status, data } = await req(port, "POST", "/api/provider/switch", {
        provider: "",
      });
      expect(status).toBe(400);
      expect(data.error).toMatch(/missing provider/i);
    });

    it("rejects unknown provider", async () => {
      const { status, data } = await req(port, "POST", "/api/provider/switch", {
        provider: "banana-ai",
      });
      expect(status).toBe(400);
      expect(data.error).toMatch(/invalid provider/i);
    });

    it("rejects numeric provider", async () => {
      const { status } = await req(port, "POST", "/api/provider/switch", {
        provider: 42,
      } as never);
      expect(status).toBe(400);
    });
  });

  // -- API key validation for direct providers --

  describe("API key validation (direct key providers)", () => {
    const directProviders = [
      "openai",
      "anthropic",
      "deepseek",
      "google",
      "groq",
      "xai",
      "openrouter",
    ];

    for (const provider of directProviders) {
      it(`rejects ${provider} with missing apiKey`, async () => {
        const { status, data } = await req(
          port,
          "POST",
          "/api/provider/switch",
          { provider },
        );
        expect(status).toBe(400);
        expect(data.error).toMatch(/api key is required/i);
      });

      it(`rejects ${provider} with empty string apiKey`, async () => {
        const { status, data } = await req(
          port,
          "POST",
          "/api/provider/switch",
          { provider, apiKey: "" },
        );
        expect(status).toBe(400);
        expect(data.error).toMatch(/api key is required/i);
      });

      it(`rejects ${provider} with whitespace-only apiKey`, async () => {
        const { status, data } = await req(
          port,
          "POST",
          "/api/provider/switch",
          { provider, apiKey: "   " },
        );
        expect(status).toBe(400);
        expect(data.error).toMatch(/api key is required/i);
      });
    }
  });

  // -- Successful switches --

  describe("successful provider switches", () => {
    // These providers don't require an apiKey
    const nonKeyProviders = [
      "elizacloud",
      "pi-ai",
      "openai-codex",
      "openai-subscription",
      "anthropic-subscription",
    ];

    for (const provider of nonKeyProviders) {
      it(`switches to ${provider} successfully`, async () => {
        const { status, data } = await req(
          port,
          "POST",
          "/api/provider/switch",
          { provider },
        );
        expect(status).toBe(200);
        expect(data.success).toBe(true);
        expect(data.provider).toBe(provider);
      });
    }

    // Direct key providers need apiKey
    const directProviders = [
      { provider: "openai", key: "sk-test-openai-key-1234" },
      { provider: "anthropic", key: "sk-ant-test-key-1234" },
      { provider: "deepseek", key: "sk-test-deepseek-key-1234" },
      { provider: "google", key: "AIza-test-google-key" },
      { provider: "groq", key: "gsk_test-groq-key" },
      { provider: "xai", key: "xai-test-key-1234" },
      { provider: "openrouter", key: "sk-or-test-key-1234" },
    ];

    for (const { provider, key } of directProviders) {
      it(`switches to ${provider} with valid API key`, async () => {
        const { status, data } = await req(
          port,
          "POST",
          "/api/provider/switch",
          { provider, apiKey: key },
        );
        expect(status).toBe(200);
        expect(data.success).toBe(true);
        expect(data.provider).toBe(provider);
      });
    }
  });

  // -- Credential clearing --

  describe("credential clearing", () => {
    it("switching to anthropic clears openai env key", async () => {
      // First set openai
      await req(port, "POST", "/api/provider/switch", {
        provider: "openai",
        apiKey: "sk-should-be-cleared",
      });
      expect(process.env.OPENAI_API_KEY).toBe("sk-should-be-cleared");

      // Now switch to anthropic
      await req(port, "POST", "/api/provider/switch", {
        provider: "anthropic",
        apiKey: "sk-ant-new-key",
      });
      expect(process.env.ANTHROPIC_API_KEY).toBe("sk-ant-new-key");
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
    });

    it("switching to elizacloud clears direct API keys", async () => {
      // Set a direct key first
      await req(port, "POST", "/api/provider/switch", {
        provider: "google",
        apiKey: "AIza-test-key",
      });
      expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBe(
        "AIza-test-key",
      );

      // Switch to cloud
      await req(port, "POST", "/api/provider/switch", {
        provider: "elizacloud",
      });
      expect(process.env.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
    });

    it("switching to pi-ai clears direct API keys and sets flag", async () => {
      await req(port, "POST", "/api/provider/switch", {
        provider: "openai",
        apiKey: "sk-test-openai-key-1234",
      });
      expect(process.env.OPENAI_API_KEY).toBe("sk-test-openai-key-1234");

      await req(port, "POST", "/api/provider/switch", {
        provider: "pi-ai",
      });

      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(process.env.MILADY_USE_PI_AI).toBe("1");
    });

    it("trims whitespace from API keys before storing", async () => {
      const { status } = await req(port, "POST", "/api/provider/switch", {
        provider: "openai",
        apiKey: "  sk-trimmed-key  ",
      });
      expect(status).toBe(200);
      expect(process.env.OPENAI_API_KEY).toBe("sk-trimmed-key");
    });
  });

  // -- Race guard (P0 §3) --

  describe("race condition guard", () => {
    it("rejects concurrent switch requests with 409", async () => {
      // We need an onRestart handler that takes some time to complete,
      // so the lock stays held. Start server with a slow onRestart.
      const slowServer = await startApiServer({
        port: 0,
        onRestart: () =>
          new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
      });

      try {
        // Fire first request (will succeed and hold the lock)
        const first = req(slowServer.port, "POST", "/api/provider/switch", {
          provider: "elizacloud",
        });

        // Wait a tick for the first request to be processed
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Fire second request (should be rejected)
        const second = await req(
          slowServer.port,
          "POST",
          "/api/provider/switch",
          { provider: "elizacloud" },
        );

        const firstResult = await first;
        expect(firstResult.status).toBe(200);
        expect(second.status).toBe(409);
        expect(second.data.error).toMatch(/already in progress/i);
      } finally {
        // Wait for the lock to clear before closing
        await new Promise((resolve) => setTimeout(resolve, 2500));
        await slowServer.close();
      }
    }, 10_000);
  });
});
