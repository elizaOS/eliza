/** Shared provider key-prefix hints for client and server configuration warnings. */
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
