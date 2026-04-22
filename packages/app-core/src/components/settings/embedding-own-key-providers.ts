/** Own-key embedding providers shown in settings (media-style grid). */
export type EmbeddingOwnKeyProviderId =
  | "google"
  | "groq"
  | "mistral"
  | "openai"
  | "openrouter"
  | "together";

export type EmbeddingOwnKeyProviderDef = {
  id: EmbeddingOwnKeyProviderId;
  /** i18n key for provider name (shared with media / onboarding). */
  labelKey: string;
  /** Agent `env.vars` key for the embedding model id. */
  modelEnvVar: string;
  /** Optional second env var (e.g. OpenRouter embedding dimensions). */
  dimensionsEnvVar?: string;
  defaultDimensions?: string;
  placeholder: string;
  /**
   * When set, TEXT_EMBEDDING is served via `@elizaos/plugin-openai` against this
   * OpenAI-compatible base (`POST …/embeddings`). User should have the matching
   * API key configured for AI Models (or `OPENAI_EMBEDDING_API_KEY`).
   */
  openAiEmbeddingBaseUrl?: string;
  /** For dynamic model dropdowns (`GET /api/models?provider=…`). */
  modelsCatalogProviderId?: "groq" | "mistral" | "together";
};

export const EMBEDDING_OWN_KEY_PROVIDER_DEFS: readonly EmbeddingOwnKeyProviderDef[] =
  [
    {
      id: "openai",
      labelKey: "provider.openai",
      modelEnvVar: "OPENAI_EMBEDDING_MODEL",
      placeholder: "text-embedding-3-small",
    },
    {
      id: "google",
      labelKey: "provider.google",
      modelEnvVar: "GOOGLE_EMBEDDING_MODEL",
      placeholder: "text-embedding-004",
    },
    {
      id: "openrouter",
      labelKey: "provider.openrouter",
      modelEnvVar: "OPENROUTER_EMBEDDING_MODEL",
      dimensionsEnvVar: "OPENROUTER_EMBEDDING_DIMENSIONS",
      defaultDimensions: "1536",
      placeholder: "openai/text-embedding-3-small",
    },
    {
      id: "groq",
      labelKey: "provider.groq",
      modelEnvVar: "OPENAI_EMBEDDING_MODEL",
      dimensionsEnvVar: "OPENAI_EMBEDDING_DIMENSIONS",
      defaultDimensions: "768",
      placeholder: "nomic-embed-text-v1_5",
      openAiEmbeddingBaseUrl: "https://api.groq.com/openai/v1",
      modelsCatalogProviderId: "groq",
    },
    {
      id: "mistral",
      labelKey: "provider.mistral",
      modelEnvVar: "OPENAI_EMBEDDING_MODEL",
      dimensionsEnvVar: "OPENAI_EMBEDDING_DIMENSIONS",
      defaultDimensions: "1024",
      placeholder: "mistral-embed",
      openAiEmbeddingBaseUrl: "https://api.mistral.ai/v1",
      modelsCatalogProviderId: "mistral",
    },
    {
      id: "together",
      labelKey: "provider.together",
      modelEnvVar: "OPENAI_EMBEDDING_MODEL",
      dimensionsEnvVar: "OPENAI_EMBEDDING_DIMENSIONS",
      defaultDimensions: "1024",
      placeholder: "intfloat/multilingual-e5-large-instruct",
      openAiEmbeddingBaseUrl: "https://api.together.xyz/v1",
      modelsCatalogProviderId: "together",
    },
  ];

export function defForEmbeddingOwnKeyProvider(
  id: string,
): EmbeddingOwnKeyProviderDef | undefined {
  return EMBEDDING_OWN_KEY_PROVIDER_DEFS.find((d) => d.id === id);
}

export function usesOpenAiCompatibleEmbeddingPath(
  def: EmbeddingOwnKeyProviderDef | undefined,
): boolean {
  return !!def?.openAiEmbeddingBaseUrl;
}

/** OpenRouter row in `EMBEDDING_OWN_KEY_PROVIDER_DEFS` (embedding model + dims). */
export const OPENROUTER_EMBEDDING_OWN_KEY_DEF: EmbeddingOwnKeyProviderDef =
  (() => {
    const d = EMBEDDING_OWN_KEY_PROVIDER_DEFS.find(
      (x) => x.id === "openrouter",
    );
    if (!d) {
      throw new Error(
        "[embedding-own-key-providers] openrouter embedding def missing",
      );
    }
    return d;
  })();
