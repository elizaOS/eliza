import { describe, expect, it } from "vitest";
import {
  embeddingModelIdsFromExternalRow,
  embeddingModelIdsFromProbeModels,
  hostPortKey,
  resolveBackendRowForEmbeddingSelection,
  resolveBackendRowForOpenAiEmbeddingListing,
  urlsMatchHostPort,
} from "./embedding-external-stack";
import type { ExternalLlmRuntimeRow } from "./types";

function row(
  partial: Partial<ExternalLlmRuntimeRow> & Pick<ExternalLlmRuntimeRow, "id">,
): ExternalLlmRuntimeRow {
  return {
    displayName: partial.displayName ?? partial.id,
    endpoint: partial.endpoint ?? "http://127.0.0.1",
    reachable: partial.reachable ?? true,
    models: partial.models ?? [],
    hasDownloadedModels: partial.hasDownloadedModels ?? false,
    ...partial,
  } as ExternalLlmRuntimeRow;
}

describe("embedding-external-stack", () => {
  it("hostPortKey treats 127.0.0.1 and localhost as the same", () => {
    expect(hostPortKey("http://127.0.0.1:1234/v1")).toBe("localhost:1234");
    expect(hostPortKey("http://localhost:1234")).toBe("localhost:1234");
    expect(
      urlsMatchHostPort("http://localhost:1234/v1", "http://127.0.0.1:1234"),
    ).toBe(true);
  });

  it("filters probe ids with embedding heuristic", () => {
    expect(
      embeddingModelIdsFromProbeModels([
        "llama3",
        "nomic-embed-text",
        "mxbai-embed-large",
      ]),
    ).toEqual(["nomic-embed-text", "mxbai-embed-large"]);
  });

  it("with Automatic, picks first probe-order row that lists embedding ids", () => {
    const backends: ExternalLlmRuntimeRow[] = [
      row({
        id: "ollama",
        reachable: true,
        routerInferenceReady: true,
        models: ["mistral:latest"],
      }),
      row({
        id: "lmstudio",
        displayName: "LM Studio",
        reachable: true,
        routerInferenceReady: true,
        models: ["text-embedding-ada-002", "some-chat"],
      }),
    ];
    const picked = resolveBackendRowForEmbeddingSelection("any", backends);
    expect(picked?.id).toBe("lmstudio");
    expect(embeddingModelIdsFromProbeModels(picked?.models)).toEqual([
      "text-embedding-ada-002",
    ]);
  });

  it("respects explicit stack focus", () => {
    const backends: ExternalLlmRuntimeRow[] = [
      row({
        id: "lmstudio",
        reachable: true,
        models: ["e5-small"],
      }),
    ];
    const picked = resolveBackendRowForEmbeddingSelection("lmstudio", backends);
    expect(picked?.id).toBe("lmstudio");
  });

  it("returns null for milady-gguf focus", () => {
    expect(
      resolveBackendRowForEmbeddingSelection("milady-gguf", [
        row({ id: "ollama", models: ["nomic-embed-text"] }),
      ]),
    ).toBeNull();
  });

  it("OPENAI_BASE_URL picks probe row by host:port over qualifying order", () => {
    const backends: ExternalLlmRuntimeRow[] = [
      row({
        id: "ollama",
        reachable: true,
        routerInferenceReady: true,
        models: ["nomic-embed-text"],
        endpoint: "http://127.0.0.1:11434",
      }),
      row({
        id: "lmstudio",
        displayName: "LM Studio",
        reachable: true,
        routerInferenceReady: true,
        endpoint: "http://127.0.0.1:1234",
        models: ["text-embedding-ada-002"],
      }),
    ];
    const picked = resolveBackendRowForOpenAiEmbeddingListing(
      "any",
      backends,
      "http://localhost:1234/v1",
    );
    expect(picked?.id).toBe("lmstudio");
  });

  it("explicit Only Ollama wins over OPENAI_BASE_URL host:port match", () => {
    const backends: ExternalLlmRuntimeRow[] = [
      row({
        id: "ollama",
        reachable: true,
        routerInferenceReady: true,
        models: ["nomic-embed-text", "cloud/model:latest"],
        endpoint: "http://127.0.0.1:11434",
      }),
      row({
        id: "lmstudio",
        displayName: "LM Studio",
        reachable: true,
        routerInferenceReady: true,
        endpoint: "http://127.0.0.1:1234",
        models: ["text-embedding-ada-002"],
      }),
    ];
    const picked = resolveBackendRowForOpenAiEmbeddingListing(
      "ollama",
      backends,
      "http://localhost:1234/v1",
    );
    expect(picked?.id).toBe("ollama");
  });

  it("Ollama row uses ollamaLocalModelNames for embedding id list when set", () => {
    const ollamaRow = row({
      id: "ollama",
      models: ["nomic-embed-text", "registry/cloud:latest"],
      ollamaLocalModelNames: ["nomic-embed-text"],
    });
    expect(embeddingModelIdsFromExternalRow(ollamaRow)).toEqual([
      "nomic-embed-text",
    ]);
  });

  it("Automatic prefers qualifying leader over earlier reachable row with embed id", () => {
    const backends: ExternalLlmRuntimeRow[] = [
      row({
        id: "ollama",
        reachable: true,
        routerInferenceReady: false,
        hasDownloadedModels: true,
        models: ["nomic-embed-text"],
      }),
      row({
        id: "lmstudio",
        displayName: "LM Studio",
        reachable: true,
        routerInferenceReady: true,
        models: ["text-embedding-3-small"],
      }),
    ];
    const picked = resolveBackendRowForEmbeddingSelection("any", backends);
    expect(picked?.id).toBe("lmstudio");
  });
});
