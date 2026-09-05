/** Detects MCP schema-compatibility policy from host-projected model metadata. */

export type McpModelProvider =
  | "openai"
  | "anthropic"
  | "google"
  | "openrouter"
  | "bitrouter"
  | "unknown";

export interface McpModelInfo {
  readonly provider: McpModelProvider;
  readonly modelId: string;
  readonly supportsStructuredOutputs: boolean;
  readonly isReasoningModel: boolean;
}

export interface McpRuntimeModelProjection {
  readonly modelProvider?: unknown;
  readonly model?: unknown;
  readonly character?: {
    readonly settings?: Readonly<Record<string, unknown>> | null;
  } | null;
}

export function detectMcpModelProvider(
  runtime: McpRuntimeModelProjection,
): McpModelInfo {
  const settings = runtime.character?.settings;
  const providerText = String(
    runtime.modelProvider ??
      settings?.MODEL_PROVIDER ??
      settings?.modelProvider ??
      "",
  ).toLowerCase();
  const modelId =
    String(runtime.model ?? settings?.MODEL ?? settings?.model ?? providerText)
      .trim()
      .toLowerCase() || "unknown";
  const combined = `${providerText} ${modelId}`;
  const isReasoningModel = /(^|[\s/])(o1|o3)([-\s/]|$)/.test(combined);

  let provider: McpModelProvider = "unknown";
  if (/openai|gpt-|(^|[\s/])(o1|o3)([-\s/]|$)/.test(combined)) {
    provider = "openai";
  } else if (/anthropic|claude/.test(combined)) {
    provider = "anthropic";
  } else if (/google|gemini/.test(combined)) {
    provider = "google";
  } else if (/bitrouter/.test(combined)) {
    provider = "bitrouter";
  } else if (/openrouter/.test(combined)) {
    provider = "openrouter";
  }

  return {
    provider,
    modelId,
    supportsStructuredOutputs:
      provider === "anthropic" ||
      provider === "google" ||
      (provider === "openai" && /gpt-5|o1|o3/.test(modelId)),
    isReasoningModel,
  };
}
