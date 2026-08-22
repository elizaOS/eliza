/**
 * Provider-SDK boundary test for Google embedding admission. A real
 * `GoogleGenAI` client talks to a deterministic local HTTP server, proving the
 * handler sends provider `countTokens` requests before the embedding request
 * and rejects an oversized request without embedding a prefix.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { GoogleGenAI } from "@google/genai";
import { afterEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  client: undefined as GoogleGenAI | undefined,
}));

vi.mock("../utils/config", async () => {
  const actual =
    await vi.importActual<typeof import("../utils/config")>("../utils/config");
  return {
    ...actual,
    createGoogleGenAI: () => sdk.client ?? null,
  };
});

import { handleTextEmbedding } from "../models/embedding";

type CapturedRequest = { path: string; text: string };

function requestText(body: Record<string, unknown>): string {
  const content = body.content as
    | { parts?: Array<{ text?: string }> }
    | undefined;
  const contents = body.contents as
    | Array<{ parts?: Array<{ text?: string }> }>
    | undefined;
  const requests = body.requests as
    | Array<{ content?: { parts?: Array<{ text?: string }> } }>
    | undefined;
  return (
    contents?.[0]?.parts?.[0]?.text ??
    content?.parts?.[0]?.text ??
    requests?.[0]?.content?.parts?.[0]?.text ??
    ""
  );
}

function createRuntime(model = "gemini-embedding-001"): IAgentRuntime {
  return {
    emitEvent: vi.fn(async () => undefined),
    getSetting: vi.fn((key: string) => {
      if (key === "GOOGLE_EMBEDDING_MODEL") return model;
      return null;
    }),
  } as unknown as IAgentRuntime;
}

describe("Google embedding SDK boundary", () => {
  afterEach(() => {
    sdk.client = undefined;
  });

  it.each([
    {
      model: "gemini-embedding-001",
      inputCodePoints: 1_100,
    },
    {
      model: "models/gemini-embedding-2",
      inputCodePoints: 4_100,
    },
  ])(
    "counts with the real SDK and rejects oversized input for $model",
    async ({ model, inputCodePoints }) => {
      const captured: CapturedRequest[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as Record<string, unknown>;
          const text = requestText(body);
          captured.push({ path: request.url ?? "", text });
          response.setHeader("content-type", "application/json");
          if (request.url?.includes(":countTokens")) {
            response.end(
              JSON.stringify({ totalTokens: Array.from(text).length * 2 }),
            );
            return;
          }
          if (
            request.url?.includes(":embedContent") ||
            request.url?.includes(":batchEmbedContents")
          ) {
            response.end(
              JSON.stringify({
                embeddings: [{ values: Array(768).fill(0.5) }],
              }),
            );
            return;
          }
          response.statusCode = 404;
          response.end(
            JSON.stringify({ error: { message: "unexpected route" } }),
          );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );

      try {
        const { port } = server.address() as AddressInfo;
        sdk.client = new GoogleGenAI({
          apiKey: "deterministic-local-boundary-key",
          httpOptions: { baseUrl: `http://127.0.0.1:${port}` },
        });
        const oversized = "😀".repeat(inputCodePoints);

        await expect(
          handleTextEmbedding(createRuntime(model), oversized),
        ).rejects.toMatchObject({ code: "EMBEDDING_INPUT_TOO_LARGE" });
        expect(captured[0]).toMatchObject({
          path: expect.stringContaining(":countTokens"),
          text: oversized,
        });
        expect(captured).toHaveLength(1);
        expect(captured[0]?.path).toContain(":countTokens");
        expect(
          captured.every(({ path }) => !path.includes("models/models/")),
        ).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );
});
