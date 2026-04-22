import { describe, expect, it } from "vitest";
import {
  classifyExternalProbeModelId,
  formatExternalProbeModelInventoryShort,
  probeModelIdsForHubStatusLine,
  summarizeExternalProbeModelIds,
} from "./external-probe-model-buckets";
import type { ExternalLlmRuntimeRow } from "./types";

describe("external-probe-model-buckets", () => {
  it("classifies common embedding ids", () => {
    expect(classifyExternalProbeModelId("nomic-embed-text:latest")).toBe(
      "embedding",
    );
    expect(classifyExternalProbeModelId("mxbai-embed-large-v1")).toBe(
      "embedding",
    );
    expect(classifyExternalProbeModelId("bge-m3")).toBe("embedding");
  });

  it("classifies vision and audio hints", () => {
    expect(classifyExternalProbeModelId("llava:13b")).toBe("vision");
    expect(classifyExternalProbeModelId("qwen2.5-vl-7b")).toBe("vision");
    expect(classifyExternalProbeModelId("whisper-large-v3")).toBe("audio");
  });

  it("defaults chat LLMs to text", () => {
    expect(classifyExternalProbeModelId("llama3.1:8b")).toBe("text");
    expect(classifyExternalProbeModelId("gpt-4o")).toBe("text");
  });

  it("summarizes and formats a mixed inventory", () => {
    const c = summarizeExternalProbeModelIds([
      "llama3.1:8b",
      "nomic-embed-text:latest",
      "llava:7b",
      "whisper-tiny",
    ]);
    expect(c).toEqual({
      text: 1,
      embedding: 1,
      vision: 1,
      audio: 1,
    });
    expect(formatExternalProbeModelInventoryShort(c)).toBe(
      "1 chat · 1 embedding",
    );
  });

  it("probeModelIdsForHubStatusLine uses ollamaLocalModelNames for Ollama", () => {
    const row = {
      id: "ollama",
      displayName: "Ollama",
      endpoint: "http://localhost:11434",
      reachable: true,
      models: ["mistral:latest", "registry/x:latest"],
      ollamaLocalModelNames: ["mistral:latest"],
      hasDownloadedModels: true,
      routerInferenceReady: false,
    } as ExternalLlmRuntimeRow;
    expect(probeModelIdsForHubStatusLine(row)).toEqual(["mistral:latest"]);
  });
});
