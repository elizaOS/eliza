/**
 * Maps n8n API key credential types to their data builders.
 *
 * Separate from the OAuth `cred-type-map.ts`. These credential types
 * are resolved by reading the user's cloud API key, not via OAuth flow.
 *
 * Currently only `openAiApi` — n8n's OpenAI node expects the full credential schema.
 * n8n validates with allOf and requires all fields, even conditional ones.
 * The cloud's OpenAI-compatible proxy at /api/v1/chat/completions handles
 * billing, rate limiting, and routing through OpenRouter.
 */

interface ApiKeyCredMapping {
  buildData(apiKey: string, baseUrl: string): Record<string, unknown>;
}

export const API_KEY_CRED_TYPES: Record<string, ApiKeyCredMapping> = {
  openAiApi: {
    buildData: (apiKey, baseUrl) => ({
      apiKey,
      organizationId: "",
      url: `${baseUrl}/api/v1`,
      header: false,
    }),
  },
};
