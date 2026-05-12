import { afterEach, describe, expect, it, vi } from "vitest";
import { searchHuggingFaceGguf } from "./hf-search";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

describe("searchHuggingFaceGguf", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("infers decimal and two-billion parameter tiers without stale labels", async () => {
    const details = new Map<string, unknown>([
      [
        "Qwen/Qwen3.5-0.8B-GGUF",
        {
          id: "Qwen/Qwen3.5-0.8B-GGUF",
          pipeline_tag: "text-generation",
          siblings: [{ rfilename: "qwen3.5-0.8b-q4_k_m.gguf", size: 512 }],
          tags: ["gguf", "text-generation"],
        },
      ],
      [
        "Qwen/Qwen3.5-2B-GGUF",
        {
          id: "Qwen/Qwen3.5-2B-GGUF",
          pipeline_tag: "text-generation",
          siblings: [{ rfilename: "qwen3.5-2b-q4_k_m.gguf", size: 512 }],
          tags: ["gguf", "text-generation"],
        },
      ],
      [
        "org/legacy-1.7b-GGUF",
        {
          id: "org/legacy-1.7b-GGUF",
          pipeline_tag: "text-generation",
          siblings: [{ rfilename: "legacy-1.7b-q4_k_m.gguf", size: 512 }],
          tags: ["gguf"],
        },
      ],
    ]);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://huggingface.co/api/models?")) {
        return jsonResponse([...details.keys()].map((id) => ({ id })));
      }

      const encodedId = url.replace("https://huggingface.co/api/models/", "");
      const detail = details.get(decodeURIComponent(encodedId));
      if (detail) return jsonResponse(detail);
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await searchHuggingFaceGguf("qwen", 3);

    expect(results.map((result) => [result.params, result.bucket])).toEqual([
      ["0.8B", "small"],
      ["2B", "small"],
      ["2B", "small"],
    ]);
  });
});
