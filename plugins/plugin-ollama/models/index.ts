/** Barrel for the Ollama model handlers: text (small/large), embedding, and the model-availability pull. */
export { ensureModelAvailable } from "./availability";
export { handleTextEmbedding } from "./embedding";
export { handleTextLarge, handleTextSmall } from "./text";
