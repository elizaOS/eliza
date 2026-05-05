/**
 * Whether to prefetch the local GGUF embedding model before runtime boot.
 *
 * Chat/inference provider (what you pick in onboarding) is separate from
 * **embeddings** (vector memory / RAG). By default The framework keeps
 * `@elizaos/plugin-local-embedding` loaded because API-based model plugins do
 * not implement TEXT_EMBEDDING — so a local model was historically always
 * warmed up. When Eliza Cloud is connected with **cloud embeddings** enabled,
 * the cloud plugin handles embeddings instead; skipping warmup avoids a large
 * download unrelated to “local inference” for chat.
 */

function isTruthyEnv(...names: string[]): boolean {
  for (const name of names) {
    const v = process.env[name]?.trim().toLowerCase();
    if (v === "1" || v === "true" || v === "yes") return true;
  }
  return false;
}

export function shouldWarmupLocalEmbeddingModel(): boolean {
  if (isTruthyEnv("ELIZA_DISABLE_LOCAL_EMBEDDINGS")) {
    return false;
  }

  const cloudEmbeddingsRoutedLocally = isTruthyEnv(
    "ELIZA_CLOUD_EMBEDDINGS_DISABLED",
  );

  if (cloudEmbeddingsRoutedLocally) {
    // User turned off cloud for embeddings — local plugin must serve TEXT_EMBEDDING.
    return true;
  }

  if (isTruthyEnv("ELIZAOS_CLOUD_USE_EMBEDDINGS")) {
    return false;
  }

  return true;
}
