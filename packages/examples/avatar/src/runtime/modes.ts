import type { DemoConfig, DemoMode } from "./types";

export function resolveEffectiveMode(config: DemoConfig): DemoMode {
  switch (config.mode) {
    case "openai":
      return (config.provider.openaiApiKey ?? "").trim()
        ? "openai"
        : "elizaClassic";
    case "anthropic":
      return (config.provider.anthropicApiKey ?? "").trim()
        ? "anthropic"
        : "elizaClassic";
    case "xai":
      return (config.provider.xaiApiKey ?? "").trim() ? "xai" : "elizaClassic";
    case "gemini":
      return (config.provider.googleGenaiApiKey ?? "").trim()
        ? "gemini"
        : "elizaClassic";
    case "groq":
      return (config.provider.groqApiKey ?? "").trim()
        ? "groq"
        : "elizaClassic";
    case "elizaClassic":
      return "elizaClassic";
    default:
      return "elizaClassic";
  }
}
