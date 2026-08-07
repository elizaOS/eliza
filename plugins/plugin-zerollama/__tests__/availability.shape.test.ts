/** Deterministic model-availability contract tests for lookup, pull, failure, and cancellation behavior. */
import { describe, expect, it, vi } from "vitest";
import { ensureModelAvailable } from "../models/availability";

describe("Ollama model availability", () => {
  it("returns after a successful lookup without pulling", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

    await ensureModelAvailable(" qwen3:0.6b ", "http://localhost:11434/api", fetchMock);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/api/show",
      expect.objectContaining({ body: JSON.stringify({ model: "qwen3:0.6b" }) })
    );
  });

  it("pulls a model after the daemon reports it missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"not found"}', { status: 404 }))
      .mockResolvedValueOnce(new Response('{"status":"success"}', { status: 200 }));

    await ensureModelAvailable("qwen3:0.6b", "http://localhost:11434/api", fetchMock);

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:11434/api/pull",
      expect.objectContaining({
        body: JSON.stringify({ model: "qwen3:0.6b", stream: false }),
      })
    );
  });

  it("does not reinterpret server failures as a missing model", async () => {
    const fetchMock = vi.fn(async () => new Response("daemon unavailable", { status: 503 }));

    await expect(
      ensureModelAvailable("qwen3:0.6b", "http://localhost:11434/api", fetchMock)
    ).rejects.toMatchObject({ code: "OLLAMA_MODEL_LOOKUP_FAILED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("forwards cancellation to lookup and pull requests", async () => {
    const controller = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));

    await ensureModelAvailable(
      "qwen3:0.6b",
      "http://localhost:11434/api",
      fetchMock,
      controller.signal
    );

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBe(controller.signal);
  });

  it("rejects an empty model name before touching the daemon", async () => {
    const fetchMock = vi.fn();

    await expect(ensureModelAvailable("   ", undefined, fetchMock)).rejects.toMatchObject({
      code: "OLLAMA_MODEL_NAME_REQUIRED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
