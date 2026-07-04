/** Barrel re-exporting the model handlers registered by `plugin.ts`. */
export { handleTranscription } from "./audio";
export { handleTextEmbedding } from "./embedding";
export { handleImageDescription, handleImageGeneration } from "./image";
export { handleTextLarge, handleTextSmall } from "./text";
