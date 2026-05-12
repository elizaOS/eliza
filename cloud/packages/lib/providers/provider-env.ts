import { getCloudAwareEnv } from "@/lib/runtime/cloud-bindings";

function isPlaceholderProviderKey(value: string | undefined): boolean {
  if (!value) return true;
  const normalized = value.trim().toLowerCase();
  return (
    normalized.length === 0 ||
    normalized.includes("placeholder") ||
    normalized.includes("replace_with") ||
    normalized.includes("your_") ||
    normalized.includes("your-") ||
    normalized.includes("your_openai_key") ||
    normalized.includes("your_groq_api_key")
  );
}

export function getProviderKey(envName: string): string | null {
  const apiKey = getCloudAwareEnv()[envName]?.trim();
  return isPlaceholderProviderKey(apiKey) ? null : (apiKey ?? null);
}

export function getRequiredProviderKey(envName: string): string {
  const apiKey = getProviderKey(envName);
  if (!apiKey) {
    throw new Error(`${envName} environment variable is required`);
  }

  return apiKey;
}
