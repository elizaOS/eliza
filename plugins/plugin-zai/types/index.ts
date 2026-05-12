export type ValidatedApiKey = string & { readonly __brand: "ValidatedApiKey" };

export type ModelName = string & { readonly __brand: "ModelName" };

export type ModelSize = "small" | "large";

export interface ProviderOptions {
  readonly agentName?: string;
}

export function assertValidApiKey(apiKey: string | undefined): asserts apiKey is ValidatedApiKey {
  if (!apiKey || apiKey.trim().length === 0) {
    throw new Error(
      "ZAI_API_KEY is required but not configured. " +
        "Set it in your environment variables or runtime settings."
    );
  }
}

export function createModelName(name: string): ModelName {
  if (!name || name.trim().length === 0) {
    throw new Error("Model name cannot be empty");
  }
  return name as ModelName;
}
