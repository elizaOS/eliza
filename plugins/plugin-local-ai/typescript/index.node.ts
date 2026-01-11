/**
 * Node.js entry point for Local AI plugin
 *
 * Re-exports the main plugin for Node.js environments.
 * This plugin requires native dependencies (node-llama-cpp, whisper)
 * and is only available in Node.js.
 */

export * from "./index";
export { default } from "./index";


