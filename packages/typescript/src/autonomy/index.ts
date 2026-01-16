/**
 * Autonomy Module for elizaOS Bootstrap
 *
 * Provides autonomous operation capabilities for agents.
 */

// Action
export { sendToAdminAction } from "./action";
// Providers
export { adminChatProvider, autonomyStatusProvider } from "./providers";
// Routes
export { autonomyRoutes } from "./routes";
// Service
export { AUTONOMY_SERVICE_TYPE, AutonomyService } from "./service";
// Types
export type { AutonomyConfig, AutonomyStatus } from "./types";
