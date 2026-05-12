/**
 * Known API-key prefix patterns — used by the Settings save form to
 * surface inline warnings when the user pastes something that looks
 * wrong (e.g., a model slug like `tencent/hy3-preview` into the
 * OPENROUTER_API_KEY field).
 *
 * Mirrors `KEY_PREFIX_HINTS` in
 * `packages/agent/src/api/plugin-validation.ts` — the server-side
 * version runs at save time and surfaces a warning in the validation
 * result; the client-side version here runs as the user types so they
 * catch the mistake before it lands on disk.
 *
 * Keep both in sync. If a third party plugin needs prefix validation,
 * add it here and to plugin-validation.ts. (Future: derive from a
 * shared registry; the duplication is acknowledged-but-bounded for
 * now since the data is small and rarely changes.)
 */

export interface ApiKeyPrefixHint {
  /** The exact string the value must start with (case-sensitive). */
  readonly prefix: string;
  /** Human-readable provider label for the warning text. */
  readonly label: string;
}

export const API_KEY_PREFIX_HINTS: Readonly<Record<string, ApiKeyPrefixHint>> =
  {
    ANTHROPIC_API_KEY: { prefix: "sk-ant-", label: "Anthropic" },
    OPENAI_API_KEY: { prefix: "sk-", label: "OpenAI" },
    GROQ_API_KEY: { prefix: "gsk_", label: "Groq" },
    XAI_API_KEY: { prefix: "xai-", label: "xAI" },
    OPENROUTER_API_KEY: { prefix: "sk-or-", label: "OpenRouter" },
    DEEPSEEK_API_KEY: { prefix: "sk-", label: "DeepSeek" },
    MOONSHOT_API_KEY: { prefix: "sk-", label: "Kimi / Moonshot" },
  };
