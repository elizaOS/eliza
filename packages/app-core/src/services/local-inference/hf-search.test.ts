import { afterEach, describe, expect, it, vi } from "vitest";
import { searchHuggingFaceGguf } from "./hf-search";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("searchHuggingFaceGguf", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies decimal small tiers before integer suffixes", async () => {
    const details = new Map<string, unknown>([
      [
        "Qwen/Qwen3.5-0.8B-GGUF",
        {
          id: "Qwen/Qwen3.5-0.8B-GGUF",
          tags: ["gguf", "text-generation"],
          siblings: [{ rfilename: "qwen3.5-0.8b-q4_k_m.gguf", size: 512 }],
          pipeline_tag: "text-generation",
        },
      ],
      [
        "Qwen/Qwen3.5-2B-GGUF",
        {
          id: "Qwen/Qwen3.5-2B-GGUF",
          tags: ["gguf", "text-generation"],
          siblings: [{ rfilename: "qwen3.5-2b-q4_k_m.gguf", size: 512 }],
          pipeline_tag: "text-generation",
        },
      ],
      [
        "org/legacy-1.7b-GGUF",
        {
          id: "org/legacy-1.7b-GGUF",
          tags: ["gguf"],
          siblings: [{ rfilename: "legacy-1.7b-q4_k_m.gguf", size: 512 }],
          pipeline_tag: "text-generation",
        },
      ],
      [
        "org/tiny-0.8b-GGUF",
        {
          id: "org/tiny-0.8b-GGUF",
          tags: ["gguf"],
          siblings: [{ rfilename: "tiny-0.8b-q4_k_m.gguf", size: 512 }],
          pipeline_tag: "text-generation",
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

    const results = await searchHuggingFaceGguf("qwen", 4);

    expect(results.map((result) => [result.params, result.bucket])).toEqual([
      ["0.8B", "small"],
      ["2B", "small"],
      ["2B", "small"],
      ["0.8B", "small"],
    ]);
  });
});
