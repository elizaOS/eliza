/** Barrel for the Ollama model handlers: text (small/large), embedding, audio, and the model-availability pull. */
export { handleTextToSpeech, handleTranscription } from "./audio";
export { ensureModelAvailable } from "./availability";
export { handleTextEmbedding } from "./embedding";
export { handleTextLarge, handleTextSmall } from "./text";
