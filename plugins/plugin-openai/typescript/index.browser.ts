/**
 * Browser entry point for OpenAI plugin
 *
 * Re-exports the main plugin for browser environments.
 * Assumes fetch/FormData/Blob are available as globals.
 */

export * from "./index";
export { default } from "./index";
