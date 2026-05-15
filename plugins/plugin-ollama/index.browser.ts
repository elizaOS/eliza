import { ollamaPlugin } from "./plugin";

export * from "./types";
export * from "./utils/config";
export { ollamaPlugin };

// === Phase 4B: extracted Ollama vision from packages/agent ===
export {
  OllamaVisionProvider,
  type VisionOllamaConfig,
  type VisionAnalysisOptions,
  type VisionAnalysisResult,
  type MediaProviderResult,
} from "./vision-provider";
export { VisionOllamaConfigSchema } from "./schema";
// === end Phase 4B ===

const defaultOllamaPlugin = ollamaPlugin;

export default defaultOllamaPlugin;
