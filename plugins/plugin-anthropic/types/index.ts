export type ValidatedApiKey = string & { readonly __brand: "ValidatedApiKey" };

export type ModelName = string & { readonly __brand: "ModelName" };

export type ModelSize = "small" | "large";

export function createModelName(name: string): ModelName {
  if (!name || name.trim().length === 0) {
    throw new Error("Model name cannot be empty");
  }
  return name as ModelName;
}
