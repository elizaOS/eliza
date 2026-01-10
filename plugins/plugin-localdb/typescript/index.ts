/**
 * Main entry point for plugin-localdb
 * 
 * Re-exports from the Node.js implementation by default.
 * Use ./index.browser for browser-specific imports.
 */

export * from "./index.node";
export { default } from "./index.node";

