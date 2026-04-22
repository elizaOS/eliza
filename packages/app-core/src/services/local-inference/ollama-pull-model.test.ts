import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pullOllamaModel,
  SUGGESTED_OLLAMA_EMBEDDING_MODEL,
} from "./ollama-pull-model";

function ndjsonStream(chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const c of chunks) {
        controller.enqueue(enc.encode(c));
      }
      controller.close();
    },
  });
}

describe("ollama-pull-model", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exports suggested embedding name", () => {
    expect(SUGGESTED_OLLAMA_EMBEDDING_MODEL).toBe("nomic-embed-text");
  });

  it("POSTs /api/pull with stream true and parses NDJSON until success", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      body: ndjsonStream([
        '{"status":"pulling manifest"}\n',
        '{"status":"downloading","total":1000,"completed":500}\n',
        '{"status":"success"}\n',
      ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const progress: number[] = [];
    await pullOllamaModel("http://127.0.0.1:11434/", "nomic-embed-text", {
      signal: AbortSignal.timeout(5000),
      onProgress: (p) => {
        if (p.percent != null) progress.push(p.percent);
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/pull",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "nomic-embed-text",
          stream: true,
        }),
      }),
    );
    expect(progress).toContain(50);
  });

  it("throws on streamed error field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: ndjsonStream(['{"error":"model not found"}\n']),
      }),
    );

    await expect(
      pullOllamaModel("http://localhost:11434", "x", {
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow(/model not found/);
  });

  it("throws when stream ends without success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: ndjsonStream(['{"status":"pulling manifest"}\n']),
      }),
    );

    await expect(
      pullOllamaModel("http://localhost:11434", "x", {
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow(/without a success status/);
  });

  it("throws with response text on HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "bad gateway",
      }),
    );

    await expect(
      pullOllamaModel("http://localhost:11434", "x", {
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow(/bad gateway/);
  });
});
