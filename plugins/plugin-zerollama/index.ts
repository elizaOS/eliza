/**
 * Zerollama / Ollama-compatible model provider for elizaOS.
 *
 * Registers text, embedding, TTS, and ASR handlers against any server
 * implementing the Ollama HTTP API. Auto-detects zerollama vs stock ollama
 * via GET /api/version and routes to the native zerollama client when available.
 */
export { ollamaPlugin, ollamaPlugin as zerollamaPlugin } from "./plugin";
export { ollamaPlugin as default } from "./plugin";
