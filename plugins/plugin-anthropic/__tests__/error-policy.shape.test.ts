/**
 * Failure-path tests for the #12182 error-handling policy (#12795): provider
 * credential rejection (401), invalid request (400), malformed provider JSON,
 * rate-limit retry exhaustion (429), and the CLI-mode failure surfaces
 * (unavailable Bun runtime, unparseable CLI JSON, non-zero-exit stream). Every
 * case must surface a typed error — never a fabricated completion. The image
 * handler runs the real `ai` + `@ai-sdk/anthropic` stack against a stubbed
 * global fetch; no live API.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleImageDescription } from "../models/image";
import { generateViaCli, streamViaCli } from "../utils/claude-cli";
import { executeWithRetry, formatModelError } from "../utils/retry";

function createRuntime() {
  return {
    character: { name: "ErrorPolicyTester" },
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        ANTHROPIC_API_KEY: "test-key",
        ANTHROPIC_SMALL_MODEL: "claude-test-small",
        ANTHROPIC_AUTH_MODE: "apikey",
      };
      return settings[key] ?? null;
    }),
  } as unknown as IAgentRuntime;
}

function anthropicErrorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text.length > 0) {
        controller.enqueue(new TextEncoder().encode(text));
      }
      controller.close();
    },
  });
}

function fakeBun(stdout: string, stderr: string, exitCode: number) {
  return {
    spawn: vi.fn(() => ({
      stdout: streamOf(stdout),
      stderr: streamOf(stderr),
      exited: Promise.resolve(exitCode),
    })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Anthropic provider failure surfaces (real SDK, stubbed transport)", () => {
  it("surfaces a 401 credential rejection as a typed auth failure, not a result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => anthropicErrorResponse(401, "authentication_error", "invalid x-api-key"))
    );

    const runtime = createRuntime();
    await expect(handleImageDescription(runtime, "https://example.com/image.png")).rejects.toThrow(
      /IMAGE_DESCRIPTION request .* failed: Authentication failed/
    );
    // No fabricated { title, description } and no success usage event.
    expect(
      (runtime as unknown as { emitEvent: ReturnType<typeof vi.fn> }).emitEvent
    ).not.toHaveBeenCalled();
  }, 60_000);

  it("surfaces a 400 invalid-request rejection with the provider's message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        anthropicErrorResponse(400, "invalid_request_error", "max_tokens: must be positive")
      )
    );

    await expect(
      handleImageDescription(createRuntime(), "https://example.com/image.png")
    ).rejects.toThrow(/failed: max_tokens: must be positive/);
  }, 60_000);

  it("surfaces a malformed provider response body as a typed failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<html>not json</html>", {
            status: 200,
            headers: { "content-type": "application/json" },
          })
      )
    );

    await expect(
      handleImageDescription(createRuntime(), "https://example.com/image.png")
    ).rejects.toThrow(/IMAGE_DESCRIPTION request .* failed/);
  }, 60_000);
});

describe("Anthropic retry + error translation (rate-limit / overload)", () => {
  const fastRetry = { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 2, backoffFactor: 2 };

  it("retries a 429 then surfaces the original rate-limit error, never a value", async () => {
    const rateLimit = Object.assign(new Error("rate limited"), { statusCode: 429 });
    const fn = vi.fn(async () => {
      throw rateLimit;
    });

    await expect(executeWithRetry("test op", fn, fastRetry)).rejects.toBe(rateLimit);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(formatModelError("test op", rateLimit).message).toContain(
      "Anthropic rate limited the request"
    );
  });

  it("retries a 529 overload then surfaces a typed overload failure", async () => {
    const overloaded = Object.assign(new Error("Overloaded"), { statusCode: 529 });
    const fn = vi.fn(async () => {
      throw overloaded;
    });

    await expect(executeWithRetry("test op", fn, fastRetry)).rejects.toBe(overloaded);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(formatModelError("test op", overloaded).message).toContain("temporarily overloaded");
  });

  it("does not retry a non-retryable 403 and preserves the cause chain", async () => {
    const forbidden = Object.assign(new Error("forbidden"), {
      statusCode: 403,
      data: { error: { message: "This organization has been disabled." } },
    });
    const fn = vi.fn(async () => {
      throw forbidden;
    });

    await expect(executeWithRetry("test op", fn, fastRetry)).rejects.toBe(forbidden);
    expect(fn).toHaveBeenCalledTimes(1);
    const formatted = formatModelError("test op", forbidden);
    expect(formatted.message).toContain("This organization has been disabled.");
    expect(formatted.cause).toBe(forbidden);
  });
});

describe("Anthropic CLI mode failure surfaces", () => {
  it("throws a typed error when the Bun runtime is unavailable", async () => {
    vi.stubGlobal("Bun", undefined);

    await expect(
      generateViaCli(createRuntime(), "hello", "claude-test", "TEXT_SMALL")
    ).rejects.toThrow("[Anthropic CLI] Bun runtime is required for CLI mode");
  });

  it("throws with cause when the CLI emits unparseable JSON", async () => {
    vi.stubGlobal("Bun", fakeBun("definitely-not-json", "", 0));

    const rejection = generateViaCli(createRuntime(), "hello", "claude-test", "TEXT_SMALL");
    await expect(rejection).rejects.toThrow(/\[Anthropic CLI\] Failed to parse JSON/);
    await rejection.catch((error: Error) => {
      expect(error.cause).toBeInstanceOf(SyntaxError);
    });
  });

  it("throws a typed error when the CLI exits non-zero", async () => {
    vi.stubGlobal("Bun", fakeBun("", "boom: not logged in", 1));

    await expect(
      generateViaCli(createRuntime(), "hello", "claude-test", "TEXT_SMALL")
    ).rejects.toThrow(/claude -p failed \(exit 1\): boom: not logged in/);
  });

  it("surfaces a failed CLI stream as an error instead of a healthy-empty completion", async () => {
    vi.stubGlobal("Bun", fakeBun("", "auth expired", 1));

    const result = streamViaCli(createRuntime(), "hello", "claude-test", "TEXT_SMALL");

    const consume = async () => {
      const chunks: string[] = [];
      for await (const chunk of result.textStream) {
        chunks.push(chunk);
      }
      return chunks;
    };

    await expect(consume()).rejects.toThrow(
      /\[Anthropic CLI\] claude -p stream failed \(exit 1\): auth expired/
    );
    // The finish reason must not read as a successful end_turn.
    await expect(result.finishReason).resolves.toBe("error");
  });

  it("still resolves end_turn for a successful stream with a result event", async () => {
    const lines = [
      JSON.stringify({
        type: "stream_event",
        event: { delta: { type: "text_delta", text: "hi" } },
      }),
      JSON.stringify({
        type: "result",
        modelUsage: { "claude-test": { inputTokens: 2, outputTokens: 1 } },
        stop_reason: "end_turn",
      }),
      "",
    ].join("\n");
    vi.stubGlobal("Bun", fakeBun(lines, "", 0));

    const result = streamViaCli(createRuntime(), "hello", "claude-test", "TEXT_SMALL");
    const chunks: string[] = [];
    for await (const chunk of result.textStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hi"]);
    await expect(result.finishReason).resolves.toBe("end_turn");
  });
});
