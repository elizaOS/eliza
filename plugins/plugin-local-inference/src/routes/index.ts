/**
 * Route-side exports for plugin-local-inference.
 *
 * Consumers (app-core/api/server.ts) import from
 * `@elizaos/plugin-local-inference/routes` to mount the HTTP compat routes
 * for model catalog, downloads, status, and chat commands.
 */

export * from "./local-inference-compat-routes.js";
export * from "./local-inference-tts-route.js";
