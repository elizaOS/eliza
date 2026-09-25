/** Observes vector generation, not semantic retrieval quality or benchmark success. */
export type BenchmarkEmbeddingCapability =
  | { status: "available"; dimension: number }
  | { status: "unavailable"; error: string }
  | { status: "disabled" | "stand-in" | "unverified" };

export async function probeBenchmarkEmbedding(options: {
  disabled: boolean;
  standIn: boolean;
  generate: () => Promise<unknown>;
}): Promise<BenchmarkEmbeddingCapability> {
  if (options.standIn) return { status: "stand-in" };
  if (options.disabled) return { status: "disabled" };
  try {
    // A null-input dimension probe can return a synthetic vector. The caller
    // must generate from real text through the production runtime instead.
    const vector = await options.generate();
    if (
      !Array.isArray(vector) ||
      vector.length === 0 ||
      !vector.every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ) ||
      !vector.some((value) => value !== 0)
    ) {
      throw new Error("Embedding provider returned an invalid or zero vector");
    }
    return { status: "available", dimension: vector.length };
  } catch (error) {
    return {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
