/**
 * Regression coverage for handleImageDescription's transient-503 handling:
 * a cold-cache `billing_cache_warming` 503 must be retried in place (it clears
 * within ~1s on retry — the client companion to the server escape in #18249),
 * and a genuine failure must throw (fail closed) instead of fabricating a
 * `{ description: "Error: ..." }` object that would leak into LLM context.
 * The cloud SDK client is mocked; no network.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const postRaw = vi.fn();
vi.mock("../src/utils/sdk-client", () => ({
  createElizaCloudClient: () => ({ routes: { postApiV1ChatCompletionsRaw: postRaw } }),
}));

const { handleImageDescription } = await import("../src/models/image");

function runtime(): IAgentRuntime {
  return {
    getSetting: () => "",
    emitEvent: () => {},
  } as unknown as IAgentRuntime;
}

function warming503(): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: "Billing authorization is warming. Retry shortly.",
        type: "service_unavailable",
        code: "billing_cache_warming",
        retryAfter: 1,
      },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } }
  );
}

function ok(description: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: description } }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("handleImageDescription warming-503 retry", () => {
  afterEach(() => {
    postRaw.mockReset();
  });

  it("rides through a cold-cache warming 503 and returns the description", async () => {
    postRaw
      .mockResolvedValueOnce(warming503())
      .mockResolvedValueOnce(ok("A red square."));

    const result = await handleImageDescription(runtime(), {
      imageUrl: "https://example.com/red.png",
      prompt: "describe",
    });

    expect(postRaw).toHaveBeenCalledTimes(2);
    // parseImageDescriptionResponse yields a title/description; the content survived.
    expect(JSON.stringify(result)).toContain("red square");
  });

  it("throws (fails closed) instead of fabricating an error description on a hard 500", async () => {
    postRaw.mockResolvedValue(
      new Response("upstream boom", { status: 500 })
    );

    await expect(
      handleImageDescription(runtime(), {
        imageUrl: "https://example.com/x.png",
        prompt: "describe",
      })
    ).rejects.toThrow();
    // Must NOT resolve to a { description: "Error: ..." } object.
  });

  it("does not retry a non-warming 503 forever — bounded and then throws", async () => {
    postRaw.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "gone" } }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(
      handleImageDescription(runtime(), {
        imageUrl: "https://example.com/x.png",
        prompt: "describe",
      })
    ).rejects.toThrow();
    // A bare 503 with no warming code is not the warming case: fail fast, one attempt.
    expect(postRaw).toHaveBeenCalledTimes(1);
  });
});
