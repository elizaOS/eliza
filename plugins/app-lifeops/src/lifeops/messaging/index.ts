export { createOwnerSendPolicy } from "./owner-send-policy.js";
export { XDmAdapter } from "./adapters/x-dm-adapter.js";
export { CalendlyAdapter } from "./adapters/calendly-adapter.js";
export { BrowserBridgeAdapter } from "./adapters/browser-bridge-adapter.js";

/**
 * W15 INTEGRATION NOTES:
 * - In plugin.ts boot, register createOwnerSendPolicy() via core's registerSendPolicy(runtime, ...).
 * - Register XDmAdapter, CalendlyAdapter, BrowserBridgeAdapter via the triage service's adapter registry
 *   (find the registration pattern in @elizaos/core/features/messaging/triage/triage-service.ts).
 * - Remove any imports of the deleted action files from plugin.ts/index.ts.
 * - Add OWNER_CHECKIN to the action exports.
 */
