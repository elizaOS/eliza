import { describe, expect, it } from "vitest";
import { zerollamaEmbedMany } from "../utils/zerollama-native.ts";

describe("zerollama surrogate safety", () => {
  it("preserves surrogate pairs when formatting error responses", async () => {
    // "x" + "🔥" * 160 -> 321 code units > 300
    const bisectingBody = "x" + "🔥".repeat(160);
    const mockFetch = async () =>
      new Response(bisectingBody, {
        status: 500,
        statusText: "Internal Server Error",
      });

    await expect(
      zerollamaEmbedMany({
        apiBase: "http://localhost:8080",
        model: "nomic-embed-text",
        input: "test",
        fetchImpl: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow();

    try {
      await zerollamaEmbedMany({
        apiBase: "http://localhost:8080",
        model: "nomic-embed-text",
        input: "test",
        fetchImpl: mockFetch as unknown as typeof fetch,
      });
    } catch (err: unknown) {
      const msg = (err as Error).message;
      for (const char of msg) {
        expect(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(
            char,
          ),
        ).toBe(false);
      }
    }
  });
});
