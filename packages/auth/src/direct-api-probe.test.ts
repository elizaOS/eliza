/**
 * Exercises direct provider credential probes against deterministic fetch
 * responses, including complete provider diagnostics and unavailable bodies.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeDirectApiKey } from "./direct-api-probe.ts";

describe("probeDirectApiKey", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it("marks an over-limit body instead of trimming it silently", async () => {
    // The base URL is operator-configurable via *_BASE_URL, so the diagnostic
    // read is bounded. A reader must be able to tell a complete body from a cut
    // one — that is the whole point of dropping the old silent slice(0, 200).
    const oversized = "y".repeat(64 * 1024 + 10);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(oversized, { status: 500 })),
    );

    const result = await probeDirectApiKey("openai-api", "provider-key");

    // Exactly the cap is retained, then the marker — assert on the kept body
    // itself, since the marker and status prefix are added on top of it.
    expect(result.error).toBe(
      `openai-api 500: ${"y".repeat(64 * 1024)}[truncated: ${64 * 1024 + 10} bytes exceeded the ${64 * 1024}-byte probe diagnostic limit]`,
    );
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
