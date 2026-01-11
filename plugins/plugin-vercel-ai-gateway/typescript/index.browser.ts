/**
 * Browser entry point for Vercel AI Gateway plugin.
 * Browser builds should use a proxy endpoint to avoid exposing API keys.
 */

export * from "./index";
export { gatewayPlugin as default } from "./index";
