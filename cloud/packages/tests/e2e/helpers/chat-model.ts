export function resolveE2EChatModel(defaultModel: string): string {
  const configuredModel = process.env.E2E_CHAT_MODEL?.trim();
  if (configuredModel) {
    return configuredModel;
  }

  if (process.env.OPENAI_BASE_URL?.trim()) {
    throw new Error("E2E_CHAT_MODEL must be set when OPENAI_BASE_URL is configured");
  }

  return defaultModel;
}
