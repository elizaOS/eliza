/**
 * Exercises direct provider credential probes against deterministic fetch
 * responses, including complete provider diagnostics, header conventions, and base URL overrides.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  directProviderBaseUrl,
  probeDirectApiKey,
} from "./direct-api-probe.ts";

describe("directProviderBaseUrl", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns default URLs when environment overrides are not set", () => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.OPENAI_BASE_URL;
    delete process.env.DEEPSEEK_BASE_URL;
    delete process.env.ZAI_BASE_URL;
    delete process.env.Z_AI_BASE_URL;
    delete process.env.MOONSHOT_BASE_URL;
    delete process.env.KIMI_BASE_URL;
    delete process.env.CEREBRAS_BASE_URL;

    expect(directProviderBaseUrl("anthropic-api")).toBe(
      "https://api.anthropic.com/v1",
    );
    expect(directProviderBaseUrl("openai-api")).toBe(
      "https://api.openai.com/v1",
    );
    expect(directProviderBaseUrl("deepseek-api")).toBe(
      "https://api.deepseek.com",
    );
    expect(directProviderBaseUrl("zai-api")).toBe(
      "https://api.z.ai/api/paas/v4",
    );
    expect(directProviderBaseUrl("moonshot-api")).toBe(
      "https://api.moonshot.ai/v1",
    );
    expect(directProviderBaseUrl("cerebras-api")).toBe(
      "https://api.cerebras.ai/v1",
    );
  });

  it("honors environment overrides for base URLs", () => {
    process.env.ANTHROPIC_BASE_URL = "https://custom.anthropic.internal";
    process.env.OPENAI_BASE_URL = "https://custom.openai.internal";
    process.env.DEEPSEEK_BASE_URL = "https://custom.deepseek.internal";
    process.env.ZAI_BASE_URL = "https://custom.zai.internal";
    process.env.MOONSHOT_BASE_URL = "https://custom.moonshot.internal";
    process.env.CEREBRAS_BASE_URL = "https://custom.cerebras.internal";

    expect(directProviderBaseUrl("anthropic-api")).toBe(
      "https://custom.anthropic.internal",
    );
    expect(directProviderBaseUrl("openai-api")).toBe(
      "https://custom.openai.internal",
    );
    expect(directProviderBaseUrl("deepseek-api")).toBe(
      "https://custom.deepseek.internal",
    );
    expect(directProviderBaseUrl("zai-api")).toBe(
      "https://custom.zai.internal",
    );
    expect(directProviderBaseUrl("moonshot-api")).toBe(
      "https://custom.moonshot.internal",
    );
    expect(directProviderBaseUrl("cerebras-api")).toBe(
      "https://custom.cerebras.internal",
    );
  });

  it("honors secondary alias environment variables for zai and moonshot", () => {
    delete process.env.ZAI_BASE_URL;
    process.env.Z_AI_BASE_URL = "https://secondary.z.ai";
    expect(directProviderBaseUrl("zai-api")).toBe("https://secondary.z.ai");

    delete process.env.MOONSHOT_BASE_URL;
    process.env.KIMI_BASE_URL = "https://secondary.kimi.moonshot";
    expect(directProviderBaseUrl("moonshot-api")).toBe(
      "https://secondary.kimi.moonshot",
    );
  });
});

describe("probeDirectApiKey", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Anthropic-specific headers and models query limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeDirectApiKey("anthropic-api", "ant-key-123");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models?limit=1",
      expect.objectContaining({
        method: "GET",
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": "ant-key-123",
        },
      }),
    );
  });

  it("sends Bearer authorization header for OpenAI-compatible providers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), {
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeDirectApiKey("openai-api", "sk-openai-test");
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        method: "GET",
        headers: {
          Authorization: "Bearer sk-openai-test",
        },
      }),
    );
  });

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

  it("rejects declared content-length exceeding the limit before reading body", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers({ "content-length": "70000" }),
      body: null,
      text: vi.fn(),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await probeDirectApiKey("openai-api", "provider-key");
    expect(result.ok).toBe(false);
    expect(result.error).toContain(
      `[response body rejected: 70000 bytes exceeds the ${64 * 1024}-byte probe diagnostic limit]`,
    );
  });

  it("translates fetch network/transport errors into a failed probe result with status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValue(new TypeError("fetch failed: network unreachable")),
    );

    const result = await probeDirectApiKey("deepseek-api", "provider-key");
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toBe("fetch failed: network unreachable");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("keeps the HTTP status when the provider body cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn().mockRejectedValue(new Error("stream failed")),
      }),
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
