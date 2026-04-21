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
export function shouldWarmupLocalEmbeddingModel(): boolean {
  if (
    process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS === "1" ||
    process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS === "1"
  ) {
    return false;
  }

  const cloudEmbeddingsRoutedLocally =
    process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED === "1" ||
    process.env.ELIZA_CLOUD_EMBEDDINGS_DISABLED === "1";

  if (cloudEmbeddingsRoutedLocally) {
    // User turned off cloud for embeddings — local plugin must serve TEXT_EMBEDDING.
    return true;
  }

  if (process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS === "true") {
    return false;
  }

  return true;
}
